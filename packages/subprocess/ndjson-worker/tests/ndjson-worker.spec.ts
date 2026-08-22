import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { NdjsonWorker, type NdjsonWorkerSpec } from '../src/index.ts'

/** One scripted child process whose stdio the test drives. */
class FakeChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  readonly lines: string[] = []
  terminated = false
  private settle!: (outcome: SubprocessOutcome) => void
  private fail!: (error: unknown) => void

  /** When false, terminate() leaves `done` pending, as a process that outlives its stop would. */
  settleOnTerminate = true

  constructor(readonly argv: readonly string[], readonly cwd: string | undefined, stderrText = '') {
    this.collected = {
      stderr: { readFrom: () => ({ text: stderrText }) },
    } as unknown as SubprocessHandle['collected']
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') this.lines.push(line)
      }
    })
  }

  emit(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  exit(outcome: SubprocessOutcome = { exitCode: 2, signal: null }): void {
    this.settle(outcome)
  }

  crash(error: unknown): void {
    this.fail(error)
  }

  terminate(): void {
    this.terminated = true
    if (this.settleOnTerminate) this.settle({ exitCode: null, signal: 'SIGTERM' })
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

const SPEC: NdjsonWorkerSpec = {
  executable: 'python3',
  args: ['worker.py', '--flag'],
  cwd: '/tmp/worker',
  label: 'test: worker',
  idleShutdownMs: 20,
  graceMs: 100,
  diagnosticBytes: 1024,
}

function harness(options: { stderr?: string; noStdio?: boolean; spec?: Partial<NdjsonWorkerSpec> } = {}) {
  const children: FakeChild[] = []
  const lines: string[] = []
  const failures: Error[] = []
  let idle = true
  const ctx = {
    subprocess: {
      resolveExecutable: (command: string) => Promise.resolve(`/usr/bin/${command}`),
      spawn: (spawnSpec: SubprocessSpawnSpec) => {
        const child = new FakeChild(spawnSpec.argv, spawnSpec.cwd, options.stderr ?? '')
        children.push(child)
        if (options.noStdio === true) {
          return {
            stdin: undefined,
            stdout: undefined,
            terminate: () => { child.terminated = true },
            waitForExit: () => Promise.resolve(true),
            done: new Promise(() => {}),
          } as unknown as SubprocessHandle
        }
        return child as unknown as SubprocessHandle
      },
    },
  } as unknown as Context
  const worker = new NdjsonWorker(ctx, { ...SPEC, ...options.spec }, {
    onLine: (line) => { lines.push(line) },
    onFailure: (error) => { failures.push(error) },
    isIdle: () => idle,
  })
  return { worker, children, lines, failures, setIdle: (value: boolean) => { idle = value } }
}

describe('NdjsonWorker', () => {
  it('resolves the executable and passes the spec through to spawn', async () => {
    const { worker, children } = harness()
    await worker.ensureStarted()
    expect(children[0]?.argv).toEqual(['/usr/bin/python3', 'worker.py', '--flag'])
    expect(children[0]?.cwd).toBe('/tmp/worker')
    expect(worker.running).toBe(true)
    await worker.dispose()
  })

  it('starts at most one process for concurrent callers', async () => {
    const { worker, children } = harness()
    await Promise.all([worker.ensureStarted(), worker.ensureStarted(), worker.ensureStarted()])
    expect(children).toHaveLength(1)
    await worker.dispose()
  })

  it('is a no-op when a process is already live', async () => {
    const { worker, children } = harness()
    await worker.ensureStarted()
    await worker.ensureStarted()
    expect(children).toHaveLength(1)
    await worker.dispose()
  })

  it('forwards each stdout line', async () => {
    const { worker, children, lines } = harness()
    await worker.ensureStarted()
    children[0]?.emit('{"a":1}')
    children[0]?.emit('{"b":2}')
    await vi.waitFor(() => { expect(lines).toEqual(['{"a":1}', '{"b":2}']) })
    await worker.dispose()
  })

  it('writes one JSON line per value', async () => {
    const { worker, children } = harness()
    await worker.ensureStarted()
    worker.write({ id: 1, text: '中文' })
    await vi.waitFor(() => { expect(children[0]?.lines).toEqual(['{"id":1,"text":"中文"}']) })
    await worker.dispose()
  })

  it('drops a write when no process is live', () => {
    const { worker, children } = harness()
    worker.write({ id: 1 })
    expect(children).toHaveLength(0)
  })

  it('reports an unexpected exit with its retained stderr', async () => {
    const { worker, children, failures } = harness({ stderr: 'ModuleNotFoundError: qwen_asr' })
    await worker.ensureStarted()
    children[0]?.exit({ exitCode: 2, signal: null })
    await vi.waitFor(() => {
      expect(failures[0]?.message).toBe('test: worker exited with 2: ModuleNotFoundError: qwen_asr')
    })
    expect(worker.running).toBe(false)
    await worker.dispose()
  })

  it('reports an exit with no diagnostics without a trailing separator', async () => {
    const { worker, children, failures } = harness()
    await worker.ensureStarted()
    children[0]?.exit({ exitCode: 1, signal: null })
    await vi.waitFor(() => { expect(failures[0]?.message).toBe('test: worker exited with 1') })
    await worker.dispose()
  })

  it('reports a process that failed rather than exited', async () => {
    const { worker, children, failures } = harness()
    await worker.ensureStarted()
    children[0]?.crash(new Error('spawn EACCES'))
    await vi.waitFor(() => { expect(failures[0]?.message).toBe('spawn EACCES') })
    await worker.dispose()
  })

  it('stringifies a non-Error process failure', async () => {
    const { worker, children, failures } = harness()
    await worker.ensureStarted()
    children[0]?.crash('killed by the platform')
    await vi.waitFor(() => { expect(failures[0]?.message).toBe('killed by the platform') })
    await worker.dispose()
  })

  it('refuses a process that exposed no piped stdio', async () => {
    const { worker } = harness({ noStdio: true })
    await expect(worker.ensureStarted()).rejects.toThrow('test: worker did not expose piped stdio')
    expect(worker.running).toBe(false)
    await worker.dispose()
  })

  it('does not cache a failed start', async () => {
    const { worker } = harness({ noStdio: true })
    await expect(worker.ensureStarted()).rejects.toThrow(/piped stdio/)
    await expect(worker.ensureStarted()).rejects.toThrow(/piped stdio/)
    await worker.dispose()
  })

  it('stops an idle process and starts a fresh one on demand', async () => {
    const { worker, children } = harness()
    await worker.ensureStarted()
    worker.armIdleShutdown()
    await vi.waitFor(() => { expect(children[0]?.terminated).toBe(true) })
    expect(worker.running).toBe(false)
    await worker.ensureStarted()
    expect(children).toHaveLength(2)
    await worker.dispose()
  })

  it('keeps a busy process alive', async () => {
    const { worker, children, setIdle } = harness()
    await worker.ensureStarted()
    setIdle(false)
    worker.armIdleShutdown()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(children[0]?.terminated).toBe(false)
    await worker.dispose()
  })

  it('cancels a pending idle shutdown', async () => {
    const { worker, children } = harness()
    await worker.ensureStarted()
    worker.armIdleShutdown()
    worker.clearIdleShutdown()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(children[0]?.terminated).toBe(false)
    await worker.dispose()
  })

  it('ignores clearing when no shutdown is pending', async () => {
    const { worker } = harness()
    await worker.ensureStarted()
    worker.clearIdleShutdown()
    worker.clearIdleShutdown()
    expect(worker.running).toBe(true)
    await worker.dispose()
  })

  it('arms nothing when no process is live', () => {
    const { worker } = harness()
    worker.armIdleShutdown()
    expect(worker.running).toBe(false)
  })

  it('shares one stop between concurrent callers', async () => {
    const { worker, children } = harness()
    await worker.ensureStarted()
    await Promise.all([worker.stop(), worker.stop()])
    expect(children[0]?.terminated).toBe(true)
    await worker.dispose()
  })

  it('stopping without a live process resolves', async () => {
    const { worker } = harness()
    await expect(worker.stop()).resolves.toBeUndefined()
  })

  it('waits for an in-flight stop before starting again', async () => {
    const { worker, children } = harness()
    await worker.ensureStarted()
    const stopping = worker.stop()
    await worker.ensureStarted()
    await stopping
    expect(children).toHaveLength(2)
    await worker.dispose()
  })

  it('refuses to start once disposed', async () => {
    const { worker } = harness()
    await worker.dispose()
    await expect(worker.ensureStarted()).rejects.toThrow('test: worker is closed')
  })

  it('arms nothing once disposed', async () => {
    const { worker } = harness()
    await worker.ensureStarted()
    await worker.dispose()
    worker.armIdleShutdown()
    expect(worker.running).toBe(false)
  })

  it('disposes cleanly after a failed start', async () => {
    const { worker } = harness({ noStdio: true })
    await expect(worker.ensureStarted()).rejects.toThrow(/piped stdio/)
    await expect(worker.dispose()).resolves.toBeUndefined()
  })

  it('reports a broken stdin and stops the process', async () => {
    const { worker, children, failures } = harness()
    await worker.ensureStarted()
    const child = children[0] as FakeChild
    vi.spyOn(child.stdin, 'write').mockImplementation(((
      _chunk: unknown,
      callback: (error?: Error | null) => void,
    ) => {
      callback(new Error('EPIPE'))
      return true
    }) as never)
    worker.write({ id: 1 })
    await vi.waitFor(() => {
      expect(failures[0]?.message).toBe('test: worker input failed: EPIPE')
      expect(child.terminated).toBe(true)
    })
    await worker.dispose()
  })

  it('ignores a late exit from a process it already replaced', async () => {
    const { worker, children, failures } = harness()
    await worker.ensureStarted()
    const first = children[0] as FakeChild
    await worker.stop()
    await worker.ensureStarted()
    first.exit({ exitCode: 9, signal: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(failures).toEqual([])
    await worker.dispose()
  })
})

describe('NdjsonWorker replaced-process guards', () => {
  it('ignores a late failure from a process it already replaced', async () => {
    const { worker, children, failures } = harness()
    await worker.ensureStarted()
    const first = children[0] as FakeChild
    first.settleOnTerminate = false
    await worker.stop()
    await worker.ensureStarted()
    first.crash(new Error('late spawn failure'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(failures).toEqual([])
    expect(worker.running).toBe(true)
    await worker.dispose()
  })
})
