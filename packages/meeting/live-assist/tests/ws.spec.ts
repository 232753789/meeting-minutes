import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { LIVE_ASSIST_SOCKET_PATH, type ServerMessage } from '../src/protocol.ts'
import type { LiveAsrWorker, WorkerListener } from '../src/worker.ts'
import {
  closeAcceptor,
  LiveAssistSockets,
  parseClientMessage,
  sendTo,
  toBuffer,
} from '../src/ws.ts'
import { modelDirectory } from './support/model-directory.ts'

describe('parseClientMessage', () => {
  it('accepts every control message', () => {
    expect(parseClientMessage('{"type":"pause"}')).toEqual({ type: 'pause' })
    expect(parseClientMessage('{"type":"resume"}')).toEqual({ type: 'resume' })
    expect(parseClientMessage('{"type":"start","background":"简历","session":"session-1"}'))
      .toEqual({ type: 'start', background: '简历', session: 'session-1' })
  })

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['an unknown type', '{"type":"launch"}'],
    ['start without background', '{"type":"start","session":"session-1"}'],
    ['start with a non-string background', '{"type":"start","background":5,"session":"session-1"}'],
    ['start without a session', '{"type":"start","background":"x"}'],
    ['start with a non-string session', '{"type":"start","background":"x","session":5}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toBeUndefined()
  })
})

/** A recognizer that records what the session asked of it and can push events back. */
class FakeWorker {
  readonly opened: string[] = []
  readonly closed: string[] = []
  readonly frames: Buffer[] = []
  listener: WorkerListener | undefined
  failOpen: Error | undefined
  failOpenValue: string | undefined

  open(session: string, listener: WorkerListener): Promise<void> {
    if (this.failOpen !== undefined) return Promise.reject(this.failOpen)
    // A provider rejecting with a bare string is exactly what the route must still report,
    // so this test deliberately produces the rejection the rule normally forbids.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (this.failOpenValue !== undefined) return Promise.reject(this.failOpenValue)
    this.opened.push(session)
    this.listener = listener
    return Promise.resolve()
  }

  push(_session: string, pcm: Buffer): void {
    this.frames.push(pcm)
  }

  close(session: string): void {
    this.closed.push(session)
  }
}

/** The one target session the route resolves; `missing` makes the lookup fail. */
const appended: { type: string }[] = []
const ctx = {
  logger: { warn: () => {} },
  // The route resolves the optional title service through Context.get.
  get: () => undefined,
  sessions: {
    get: (id: string) => (id === 'missing' ? undefined : { append: (type: string) => { appended.push({ type }) } }),
  },
} as unknown as Context

interface Harness {
  readonly sockets: LiveAssistSockets
  readonly worker: FakeWorker
  readonly server: Server
  readonly url: string
}

const harnesses: Harness[] = []

async function harness(overrides: Partial<ResolvedConfig> = {}): Promise<Harness> {
  const config = { ...resolveConfig({ localModelPath: await modelDirectory() }), ...overrides }
  const worker = new FakeWorker()
  const sockets = new LiveAssistSockets(ctx, config, worker as unknown as LiveAsrWorker)
  const server = createServer()
  server.on('upgrade', sockets.handle)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const created: Harness = { sockets, worker, server, url: `ws://127.0.0.1:${String(port)}${LIVE_ASSIST_SOCKET_PATH}` }
  harnesses.push(created)
  return created
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data: Buffer) => { resolve(JSON.parse(data.toString('utf8')) as ServerMessage) })
  })
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => { resolve() })
    socket.once('error', reject)
  })
}

afterEach(async () => {
  for (const item of harnesses.splice(0)) {
    await item.sockets.dispose()
    await new Promise<void>((resolve) => { item.server.close(() => { resolve() }) })
  }
})

describe('LiveAssistSockets', () => {
  it('opens a recognizer session and reports ready', async () => {
    const { url, worker } = await harness()
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send(JSON.stringify({ type: 'start', background: '我的简历', session: 'session-1' }))
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: 'ready' })
    expect(worker.opened).toHaveLength(1)
    socket.close()
  })

  it('forwards binary frames only while running and not paused', async () => {
    const { url, worker } = await harness()
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send(JSON.stringify({ type: 'start', background: '', session: 'session-1' }))
    await nextMessage(socket)
    socket.send(Buffer.from([1, 0, 2, 0]))
    await vi.waitFor(() => { expect(worker.frames).toHaveLength(1) })
    socket.send(JSON.stringify({ type: 'pause' }))
    await vi.waitFor(() => { expect(worker.frames).toHaveLength(1) })
    socket.send(Buffer.from([3, 0]))
    socket.send(JSON.stringify({ type: 'resume' }))
    socket.send(Buffer.from([4, 0]))
    await vi.waitFor(() => { expect(worker.frames).toHaveLength(2) })
    socket.close()
  })

  it('refuses an oversized background and closes the socket', async () => {
    const { url } = await harness({ maxBackgroundBytes: 8 })
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send(JSON.stringify({ type: 'start', background: 'x'.repeat(64), session: 'session-1' }))
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: 'error', fatal: true })
  })

  it('reports an unsupported control message without closing', async () => {
    const { url } = await harness()
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send('{"type":"nope"}')
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: 'error', fatal: false })
    socket.close()
  })

  it('reports a recognizer that will not start', async () => {
    const { url, worker } = await harness()
    worker.failOpen = new Error('qwen-asr is unavailable')
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send(JSON.stringify({ type: 'start', background: '', session: 'session-1' }))
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'error',
      fatal: true,
      message: 'qwen-asr is unavailable',
    })
  })

  it('refuses a connection beyond maxSessions', async () => {
    const { url } = await harness({ maxSessions: 1 })
    const first = new WebSocket(url)
    await opened(first)
    const second = new WebSocket(url)
    await expect(opened(second)).rejects.toThrow(/503/)
    first.close()
  })

  it('refuses an untrusted upgrade', async () => {
    const { url } = await harness()
    const socket = new WebSocket(url, { origin: 'https://evil.example' })
    await expect(opened(socket)).rejects.toThrow(/403/)
  })

  it('releases the recognizer session when the socket closes', async () => {
    const { url, worker } = await harness()
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send(JSON.stringify({ type: 'start', background: '', session: 'session-1' }))
    await nextMessage(socket)
    socket.close()
    await vi.waitFor(() => { expect(worker.closed).toHaveLength(1) })
  })

  it('refuses upgrades once disposed', async () => {
    const item = await harness()
    await item.sockets.dispose()
    const socket = new WebSocket(item.url)
    await expect(opened(socket)).rejects.toThrow(/503/)
  })
})

describe('toBuffer', () => {
  it('passes a Buffer through', () => {
    const buffer = Buffer.from([1, 2])
    expect(toBuffer(buffer)).toBe(buffer)
  })

  it('concatenates a fragment list', () => {
    expect(toBuffer([Buffer.from([1]), Buffer.from([2])])).toEqual(Buffer.from([1, 2]))
  })

  it('copies an ArrayBuffer', () => {
    expect(toBuffer(new Uint8Array([7, 8]).buffer)).toEqual(Buffer.from([7, 8]))
  })
})

describe('sendTo', () => {
  it('serializes a message to an open socket', () => {
    const send = vi.fn()
    sendTo({ readyState: 1, OPEN: 1, send } as never, { type: 'speech', speaking: true })
    expect(send).toHaveBeenCalledWith('{"type":"speech","speaking":true}')
  })

  it('drops a message once the socket has left OPEN', () => {
    const send = vi.fn()
    sendTo({ readyState: 3, OPEN: 1, send } as never, { type: 'speech', speaking: true })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('closeAcceptor', () => {
  /** The one method closeAcceptor calls, answering with `failure` when given one. */
  function acceptor(failure?: Error) {
    return {
      close(callback?: (error?: Error) => void): void { callback?.(failure) },
    }
  }

  it('resolves when the acceptor closed cleanly', async () => {
    await expect(closeAcceptor(acceptor())).resolves.toBeUndefined()
  })

  it('rejects with whatever the acceptor reported', async () => {
    const failure = new Error('The server is not running')
    await expect(closeAcceptor(acceptor(failure))).rejects.toThrow(failure)
  })
})

describe('LiveAssistSockets error reporting', () => {
  it('stringifies a non-Error recognizer rejection', async () => {
    const { url, worker } = await harness()
    worker.failOpenValue = '识别器不可用'
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send(JSON.stringify({ type: 'start', background: '', session: 'session-1' }))
    await expect(nextMessage(socket)).resolves.toMatchObject({ message: '识别器不可用', fatal: true })
  })
})

describe('LiveAssistSockets session resolution', () => {
  it('refuses a start naming a session the Host does not have', async () => {
    const { url } = await harness()
    const socket = new WebSocket(url)
    await opened(socket)
    socket.send(JSON.stringify({ type: 'start', background: '', session: 'missing' }))
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'error',
      fatal: true,
      message: 'live-assist: no such session missing',
    })
  })
})
