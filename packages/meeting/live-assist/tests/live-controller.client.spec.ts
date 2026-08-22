// @vitest-environment jsdom

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveAssistController, socketUrl } from '../src/client/live-controller.ts'

const capture = vi.hoisted(() => ({
  stop: vi.fn(),
  onFrame: undefined as ((frame: Int16Array) => void) | undefined,
  onEnded: undefined as (() => void) | undefined,
  failWith: undefined as unknown,
}))

vi.mock('../src/client/audio-capture.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/audio-capture.ts')>()
  return {
    ...actual,
    startSystemAudioCapture: (
      _share: MediaStream,
      options: { onFrame: (f: Int16Array) => void; onEnded: () => void },
    ) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error case is under test
      if (capture.failWith !== undefined) return Promise.reject(capture.failWith)
      capture.onFrame = options.onFrame
      capture.onEnded = options.onEnded
      return Promise.resolve({ stop: capture.stop })
    },
  }
})

class FakeSocket {
  static last: FakeSocket | undefined
  static failConstruction = false
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = 0
  binaryType = 'blob'
  readonly sent: (string | ArrayBuffer)[] = []
  readonly closed: number[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(readonly url: string) {
    if (FakeSocket.failConstruction) throw new Error('socket refused')
    FakeSocket.last = this
  }

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
  }

  send(payload: string | ArrayBuffer): void { this.sent.push(payload) }
  close(code: number): void { this.closed.push(code); this.readyState = FakeSocket.CLOSED }
  fire(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }

  open(): void { this.readyState = FakeSocket.OPEN; this.fire('open') }
  deliver(message: unknown): void { this.fire('message', { data: JSON.stringify(message) }) }
}

const shareStop = vi.fn()

/** A stand-in for the stream the click already obtained. */
function share(): MediaStream {
  return { getTracks: () => [{ stop: shareStop }] } as unknown as MediaStream
}

const FROM = 'session-a' as SessionId
const TARGET = 'session-b' as SessionId

beforeEach(() => {
  shareStop.mockClear()
  capture.stop.mockClear()
  capture.onFrame = undefined
  capture.onEnded = undefined
  capture.failWith = undefined
  FakeSocket.last = undefined
  FakeSocket.failConstruction = false
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => { vi.unstubAllGlobals() })

/** Take a controller from idle to a live recognizer in the adopted session. */
async function running(): Promise<{ controller: LiveAssistController; socket: FakeSocket }> {
  const controller = new LiveAssistController()
  controller.request('我的简历', FROM, share())
  controller.adopt(TARGET)
  const socket = await vi.waitFor(() => {
    const current = FakeSocket.last
    expect(current).toBeDefined()
    return current as FakeSocket
  })
  socket.open()
  await vi.waitFor(() => { expect(socket.sent).toHaveLength(1) })
  return { controller, socket }
}

describe('socketUrl', () => {
  it('matches the page scheme', () => {
    expect(socketUrl({ protocol: 'https:', host: 'localhost:8443' }))
      .toBe('wss://localhost:8443/live-assist/socket')
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:3000' }))
      .toBe('ws://127.0.0.1:3000/live-assist/socket')
  })
})

describe('LiveAssistController', () => {
  it('starts idle', () => {
    const controller = new LiveAssistController()
    expect(controller.getState()).toMatchObject({ running: false, connected: false, paused: false })
    expect(controller.awaiting).toBe(false)
  })

  it('marks itself running while it awaits the new session', () => {
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    expect(controller.awaiting).toBe(true)
    expect(controller.getState().running).toBe(true)
    expect(FakeSocket.last).toBeUndefined()
  })

  it('refuses to adopt into the session the request came from', () => {
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(FROM)
    expect(controller.awaiting).toBe(true)
    expect(FakeSocket.last).toBeUndefined()
  })

  it('adopts in place when the request named no session to switch away from', async () => {
    const controller = new LiveAssistController()
    controller.request('bg', undefined, share())
    controller.adopt(FROM)
    const socket = await vi.waitFor(() => {
      const current = FakeSocket.last
      expect(current).toBeDefined()
      return current as FakeSocket
    })
    socket.open()
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(1) })
    expect(JSON.parse(socket.sent[0] as string))
      .toEqual({ type: 'start', background: 'bg', session: FROM })
  })

  it('adopts into a new session and names it in the start message', async () => {
    const { socket } = await running()
    expect(JSON.parse(socket.sent[0] as string))
      .toEqual({ type: 'start', background: '我的简历', session: TARGET })
  })

  it('adopts only once', async () => {
    const { controller } = await running()
    expect(controller.awaiting).toBe(false)
    controller.adopt('session-c' as SessionId)
    expect(FakeSocket.last?.url).toBeDefined()
  })

  it('notifies subscribers on every transition', async () => {
    const controller = new LiveAssistController()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    controller.request('bg', FROM, share())
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    const before = listener.mock.calls.length
    controller.stop()
    expect(listener).toHaveBeenCalledTimes(before)
  })

  it('tracks the recognizer status the Host reports', async () => {
    const { controller, socket } = await running()
    socket.deliver({ type: 'ready', recognizer: 'live-1' })
    socket.deliver({ type: 'speech', speaking: true })
    await vi.waitFor(() => {
      expect(controller.getState()).toMatchObject({ connected: true, speaking: true })
    })
  })

  it('ignores an unparsable Host message', async () => {
    const { controller, socket } = await running()
    socket.fire('message', { data: 'not json' })
    expect(controller.getState().connected).toBe(false)
  })

  it('forwards captured frames only while the socket is open', async () => {
    const { socket } = await running()
    capture.onFrame?.(new Int16Array([1, 2]))
    expect(socket.sent).toHaveLength(2)
    socket.readyState = FakeSocket.CLOSED
    capture.onFrame?.(new Int16Array([3]))
    expect(socket.sent).toHaveLength(2)
  })

  it('pauses and resumes', async () => {
    const { controller, socket } = await running()
    controller.togglePause()
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'pause' })
    expect(controller.getState().paused).toBe(true)
    controller.togglePause()
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'resume' })
    expect(controller.getState().paused).toBe(false)
  })

  it('ignores a pause once the socket has left OPEN', async () => {
    const { controller, socket } = await running()
    socket.readyState = FakeSocket.CLOSED
    const before = socket.sent.length
    controller.togglePause()
    expect(socket.sent).toHaveLength(before)
  })

  it('stops the capture and closes the socket', async () => {
    const { controller, socket } = await running()
    controller.stop()
    expect(capture.stop).toHaveBeenCalled()
    expect(socket.closed).toEqual([1000])
    expect(controller.getState().running).toBe(false)
  })

  it('stops when the user ends the share', async () => {
    const { controller } = await running()
    capture.onEnded?.()
    expect(controller.getState().running).toBe(false)
  })

  it('stops when the Host closes the socket', async () => {
    const { controller, socket } = await running()
    socket.fire('close')
    expect(controller.getState().running).toBe(false)
  })

  it('discards a pending request on stop', () => {
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.stop()
    expect(controller.awaiting).toBe(false)
    controller.adopt(TARGET)
    expect(FakeSocket.last).toBeUndefined()
  })

  it('reports a refused share', async () => {
    capture.failWith = new Error('用户取消了共享')
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(TARGET)
    const socket = await vi.waitFor(() => FakeSocket.last as FakeSocket)
    socket.open()
    await vi.waitFor(() => {
      expect(controller.getState().failure).toEqual({ key: 'share', message: '用户取消了共享' })
    })
  })

  it('reports a socket that never opened', async () => {
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(TARGET)
    const socket = await vi.waitFor(() => FakeSocket.last as FakeSocket)
    socket.fire('error')
    await vi.waitFor(() => {
      expect(controller.getState().failure).toMatchObject({ key: 'share' })
    })
  })

  it('reports a socket that could not be constructed', () => {
    FakeSocket.failConstruction = true
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(TARGET)
    expect(controller.getState().failure).toEqual({ key: 'socket', message: 'socket refused' })
  })

  it('keeps the failure visible after a stop', async () => {
    FakeSocket.failConstruction = true
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(TARGET)
    controller.stop()
    expect(controller.getState().failure).toBeDefined()
  })
})

describe('LiveAssistController edge paths', () => {
  it('stringifies a non-Error socket construction failure', () => {
    vi.stubGlobal('WebSocket', function Refusing(): never {
      // A browser refusing the constructor with a bare string is what the state must still show.
      throw '底层拒绝'
    })
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(TARGET)
    expect(controller.getState().failure).toEqual({ key: 'socket', message: '底层拒绝' })
  })

  it('ignores a Host message of a type it does not know', async () => {
    const { controller, socket } = await running()
    const before = controller.getState()
    // Parseable, but no reducer arm claims it: the state object must stay identical.
    socket.deliver({ type: 'invented-by-a-newer-host' })
    expect(controller.getState()).toBe(before)
  })

  it('ignores a close from a socket it already replaced', async () => {
    const { controller, socket } = await running()
    controller.stop()
    const before = controller.getState()
    socket.fire('close')
    expect(controller.getState()).toEqual(before)
  })
})

describe('LiveAssistController share ownership', () => {
  it('releases a share whose request never found a session', () => {
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.stop()
    expect(shareStop).toHaveBeenCalledTimes(1)
  })

  it('releases the share when the graph cannot be built', async () => {
    capture.failWith = new Error('worklet blocked')
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(TARGET)
    const socket = await vi.waitFor(() => FakeSocket.last as FakeSocket)
    socket.open()
    await vi.waitFor(() => { expect(controller.getState().failure).toMatchObject({ key: 'share' }) })
    expect(shareStop).toHaveBeenCalled()
  })

  it('releases the share when the socket cannot be constructed', () => {
    FakeSocket.failConstruction = true
    const controller = new LiveAssistController()
    controller.request('bg', FROM, share())
    controller.adopt(TARGET)
    expect(shareStop).toHaveBeenCalled()
  })
})
