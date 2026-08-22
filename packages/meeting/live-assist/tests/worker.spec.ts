import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'

/** `Config` names both the interface and its schemastery value; the parameter type is unambiguous. */
type ConfigInput = Parameters<typeof resolveConfig>[0]
import { LiveSessionId } from '../src/protocol.ts'
import { LiveAsrWorker, parseWorkerMessage, type WorkerEvent } from '../src/worker.ts'
import { modelDirectory } from './support/model-directory.ts'

/** One scripted recognizer process whose stdout the test drives directly. */
class FakeRecognizer {
  readonly pid = 7373
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected = { stderr: undefined } as unknown as SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  readonly requests: Record<string, unknown>[] = []
  terminated = false
  private settle!: (outcome: SubprocessOutcome) => void

  constructor(readonly argv: readonly string[]) {
    this.done = new Promise<SubprocessOutcome>((resolve) => { this.settle = resolve })
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        this.requests.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
  }

  emit(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  emitRaw(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  exit(outcome: SubprocessOutcome = { exitCode: 1, signal: null }): void {
    this.settle(outcome)
  }

  terminate(): void {
    this.terminated = true
    this.settle({ exitCode: null, signal: 'SIGTERM' })
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

async function harness(overrides: ConfigInput = {}) {
  const config = resolveConfig(Object.assign({ localModelPath: await modelDirectory() }, overrides))
  const processes: FakeRecognizer[] = []
  const ctx = {
    subprocess: {
      resolveExecutable: (command: string) => Promise.resolve(command),
      spawn: (spec: SubprocessSpawnSpec) => {
        const child = new FakeRecognizer(spec.argv)
        processes.push(child)
        return child as unknown as SubprocessHandle
      },
    },
  } as unknown as Context
  return { worker: new LiveAsrWorker(ctx, config), processes }
}

describe('parseWorkerMessage', () => {
  it('accepts a tagged object', () => {
    expect(parseWorkerMessage('{"type":"ready"}')).toEqual({ type: 'ready' })
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseWorkerMessage(raw)).toThrow(/non-object message/)
  })

  it('rejects a message with no type', () => {
    expect(() => parseWorkerMessage('{"session":"a"}')).toThrow(/without a type/)
  })
})

describe('LiveAsrWorker', () => {
  it('passes every tuning value to the process and opens a session', async () => {
    const { worker, processes } = await harness({ vadMinSilenceMs: 900, maxUtteranceMs: 15_000 })
    await worker.open(LiveSessionId('s1'), () => {})
    const child = processes[0]
    expect(child).toBeDefined()
    expect(child?.argv).toEqual(expect.arrayContaining(['--min-silence-ms', '900', '--max-utterance-ms', '15000']))
    await vi.waitFor(() => { expect(child?.requests[0]).toEqual({ type: 'start', session: 's1' }) })
    expect(worker.openSessions).toBe(1)
    await worker.dispose()
  })

  it('routes events to the session that owns them', async () => {
    const { worker, processes } = await harness()
    const first: WorkerEvent[] = []
    const second: WorkerEvent[] = []
    await worker.open(LiveSessionId('s1'), event => first.push(event))
    await worker.open(LiveSessionId('s2'), event => second.push(event))
    const child = processes[0]
    child?.emit({ type: 'speech', session: 's1', speaking: true })
    child?.emit({ type: 'utterance', session: 's2', index: 1, text: '你好', seconds: 1.5 })
    await vi.waitFor(() => {
      expect(first).toEqual([{ kind: 'speech', speaking: true }])
      expect(second).toEqual([{ kind: 'utterance', index: 1, text: '你好', seconds: 1.5 }])
    })
    await worker.dispose()
  })

  it('starts exactly one process for several sessions', async () => {
    const { worker, processes } = await harness()
    await Promise.all([
      worker.open(LiveSessionId('s1'), () => {}),
      worker.open(LiveSessionId('s2'), () => {}),
    ])
    expect(processes).toHaveLength(1)
    await worker.dispose()
  })

  it('delivers a session-less failure to every open session', async () => {
    const { worker, processes } = await harness()
    const events: WorkerEvent[] = []
    await worker.open(LiveSessionId('s1'), event => events.push(event))
    processes[0]?.emit({ type: 'error', session: null, message: 'silero-vad is unavailable' })
    await vi.waitFor(() => {
      expect(events).toEqual([{ kind: 'error', message: 'silero-vad is unavailable' }])
    })
    await worker.dispose()
  })

  it('reports a malformed utterance rather than forwarding it', async () => {
    const { worker, processes } = await harness()
    const events: WorkerEvent[] = []
    await worker.open(LiveSessionId('s1'), event => events.push(event))
    processes[0]?.emit({ type: 'utterance', session: 's1', index: 'one', text: 'x', seconds: 1 })
    await vi.waitFor(() => { expect(events[0]).toMatchObject({ kind: 'error' }) })
    await worker.dispose()
  })

  it('ignores events for a session it does not know', async () => {
    const { worker, processes } = await harness()
    const events: WorkerEvent[] = []
    await worker.open(LiveSessionId('s1'), event => events.push(event))
    processes[0]?.emit({ type: 'speech', session: 'gone', speaking: true })
    processes[0]?.emit({ type: 'model-ready' })
    processes[0]?.emit({ type: 'speech', session: 's1', speaking: false })
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    await worker.dispose()
  })

  it('fails every session and stops the process on unparsable output', async () => {
    const { worker, processes } = await harness()
    const events: WorkerEvent[] = []
    await worker.open(LiveSessionId('s1'), event => events.push(event))
    processes[0]?.emitRaw('not json')
    await vi.waitFor(() => {
      expect(events[0]).toMatchObject({ kind: 'error' })
      expect(processes[0]?.terminated).toBe(true)
    })
    await worker.dispose()
  })

  it('reports an unexpected process exit with its diagnostics', async () => {
    const { worker, processes } = await harness()
    const events: WorkerEvent[] = []
    await worker.open(LiveSessionId('s1'), event => events.push(event))
    processes[0]?.exit({ exitCode: 3, signal: null })
    await vi.waitFor(() => { expect(events[0]).toMatchObject({ kind: 'error', message: /exited with 3/ }) })
    await worker.dispose()
  })

  it('drops audio for a session that was never opened', async () => {
    const { worker, processes } = await harness()
    await worker.open(LiveSessionId('s1'), () => {})
    const before = processes[0]?.requests.length ?? 0
    worker.push(LiveSessionId('other'), Buffer.from([1, 2]))
    await vi.waitFor(() => { expect(processes[0]?.requests).toHaveLength(before) })
    await worker.dispose()
  })

  it('base64-encodes forwarded audio', async () => {
    const { worker, processes } = await harness()
    const session = LiveSessionId('s1')
    await worker.open(session, () => {})
    worker.push(session, Buffer.from([1, 0, 2, 0]))
    await vi.waitFor(() => {
      expect(processes[0]?.requests.at(-1)).toEqual({
        type: 'audio',
        session: 's1',
        pcm: Buffer.from([1, 0, 2, 0]).toString('base64'),
      })
    })
    await worker.dispose()
  })

  it('stops the idle process and starts a new one for the next session', async () => {
    const { worker, processes } = await harness({ workerIdleShutdownMs: 20 })
    await worker.open(LiveSessionId('s1'), () => {})
    worker.close(LiveSessionId('s1'))
    await vi.waitFor(() => { expect(processes[0]?.terminated).toBe(true) })
    await worker.open(LiveSessionId('s2'), () => {})
    expect(processes).toHaveLength(2)
    await worker.dispose()
  })

  it('keeps the process while any session stays open', async () => {
    const { worker, processes } = await harness({ workerIdleShutdownMs: 20 })
    await worker.open(LiveSessionId('s1'), () => {})
    await worker.open(LiveSessionId('s2'), () => {})
    worker.close(LiveSessionId('s1'))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(processes[0]?.terminated).toBe(false)
    await worker.dispose()
  })

  it('ignores closing a session it never opened', async () => {
    const { worker } = await harness()
    await worker.open(LiveSessionId('s1'), () => {})
    worker.close(LiveSessionId('never'))
    expect(worker.openSessions).toBe(1)
    await worker.dispose()
  })

  it('refuses to open a session once disposed', async () => {
    const { worker } = await harness()
    await worker.dispose()
    await expect(worker.open(LiveSessionId('s1'), () => {})).rejects.toThrow(/closed/)
  })

  it('drops audio once disposed', async () => {
    const { worker, processes } = await harness()
    const session = LiveSessionId('s1')
    await worker.open(session, () => {})
    await worker.dispose()
    worker.push(session, Buffer.from([1]))
    expect(processes[0]?.requests.every(request => request.type !== 'audio')).toBe(true)
  })

  it('reports a process that fails to expose stdio', async () => {
    const config = resolveConfig({ localModelPath: await modelDirectory() })
    const ctx = {
      subprocess: {
        resolveExecutable: (command: string) => Promise.resolve(command),
        spawn: () => ({
          stdin: undefined,
          stdout: undefined,
          terminate: () => {},
          waitForExit: () => Promise.resolve(true),
          done: new Promise(() => {}),
        } as unknown as SubprocessHandle),
      },
    } as unknown as Context
    const worker = new LiveAsrWorker(ctx, config)
    await expect(worker.open(LiveSessionId('s1'), () => {})).rejects.toThrow(/piped stdio/)
    expect(worker.openSessions).toBe(0)
    await worker.dispose()
  })
})
