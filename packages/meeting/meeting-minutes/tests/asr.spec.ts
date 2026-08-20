import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { LocalAsrWorker } from '../src/asr.ts'
import { resolveConfig } from '../src/config.ts'

const MODEL_FILES = [
  'config.json', 'generation_config.json', 'chat_template.json', 'preprocessor_config.json',
  'tokenizer_config.json', 'vocab.json', 'merges.txt', 'model.safetensors.index.json',
  'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
] as const

/** One scripted worker process; `manual` mode holds requests until the test answers them. */
class FakeWorkerProcess {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected = { stderr: undefined } as unknown as SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  readonly received: number[] = []
  terminated = false
  private settle!: (outcome: SubprocessOutcome) => void

  constructor(readonly transcript: string, private readonly manual = false) {
    this.done = new Promise<SubprocessOutcome>((resolve) => { this.settle = resolve })
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        const request = JSON.parse(line) as { id: number }
        this.received.push(request.id)
        if (!this.manual) this.respond(request.id)
      }
    })
  }

  respond(id: number): void {
    this.stdout.write(`${JSON.stringify({ id, ok: true, text: this.transcript })}\n`)
  }

  terminate(): void {
    this.terminated = true
    this.settle({ exitCode: null, signal: 'SIGTERM' })
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

async function localConfigRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'meeting-asr-'))
  await mkdir(join(root, 'model'))
  for (const filename of MODEL_FILES) await writeFile(join(root, 'model', filename), '')
  return root
}

describe('local ASR worker idle shutdown', () => {
  it('terminates the idle process after the configured delay and restarts it for the next chunk', async () => {
    const root = await localConfigRoot()
    const config = resolveConfig({
      asrMode: 'local',
      storageRoot: join(root, 'meetings'),
      localModelPath: join(root, 'model'),
      asrIdleShutdownMs: 20,
      timeZone: 'Asia/Shanghai',
    })
    const processes: FakeWorkerProcess[] = []
    const ctx = {
      subprocess: {
        resolveExecutable: (command: string) => Promise.resolve(command),
        spawn: (_spec: SubprocessSpawnSpec) => {
          const child = new FakeWorkerProcess(`第${String(processes.length + 1)}次转写`)
          processes.push(child)
          return child as unknown as SubprocessHandle
        },
      },
    } as unknown as Context
    const worker = new LocalAsrWorker(ctx, config)

    expect(await worker.transcribe('/tmp/chunk-0.wav', AbortSignal.timeout(5_000))).toBe('第1次转写')
    await vi.waitFor(() => { expect(processes[0]!.terminated).toBe(true) })
    expect(processes).toHaveLength(1)

    expect(await worker.transcribe('/tmp/chunk-1.wav', AbortSignal.timeout(5_000))).toBe('第2次转写')
    expect(processes).toHaveLength(2)
    await worker.dispose()
    expect(processes[1]!.terminated).toBe(true)
  })

  it('keeps the process alive while chunks keep arriving', async () => {
    const root = await localConfigRoot()
    const config = resolveConfig({
      asrMode: 'local',
      storageRoot: join(root, 'meetings'),
      localModelPath: join(root, 'model'),
      asrIdleShutdownMs: 60_000,
      timeZone: 'Asia/Shanghai',
    })
    const processes: FakeWorkerProcess[] = []
    const ctx = {
      subprocess: {
        resolveExecutable: (command: string) => Promise.resolve(command),
        spawn: () => {
          const child = new FakeWorkerProcess('保持存活')
          processes.push(child)
          return child as unknown as SubprocessHandle
        },
      },
    } as unknown as Context
    const worker = new LocalAsrWorker(ctx, config)

    for (let chunk = 0; chunk < 3; chunk += 1) {
      expect(await worker.transcribe(`/tmp/chunk-${String(chunk)}.wav`, AbortSignal.timeout(5_000))).toBe('保持存活')
    }
    expect(processes).toHaveLength(1)
    expect(processes[0]!.terminated).toBe(false)
    await worker.dispose()
    expect(processes[0]!.terminated).toBe(true)
  })

  it('waits for every outstanding chunk before the idle countdown starts', async () => {
    const root = await localConfigRoot()
    const config = resolveConfig({
      asrMode: 'local',
      storageRoot: join(root, 'meetings'),
      localModelPath: join(root, 'model'),
      asrIdleShutdownMs: 20,
      timeZone: 'Asia/Shanghai',
    })
    const processes: FakeWorkerProcess[] = []
    const ctx = {
      subprocess: {
        resolveExecutable: (command: string) => Promise.resolve(command),
        spawn: () => {
          const child = new FakeWorkerProcess('并发转写', true)
          processes.push(child)
          return child as unknown as SubprocessHandle
        },
      },
    } as unknown as Context
    const worker = new LocalAsrWorker(ctx, config)

    const first = worker.transcribe('/tmp/chunk-0.wav', AbortSignal.timeout(5_000))
    const second = worker.transcribe('/tmp/chunk-1.wav', AbortSignal.timeout(5_000))
    const child = await vi.waitFor(() => {
      expect(processes[0]?.received).toHaveLength(2)
      return processes[0]!
    })
    child.respond(child.received[0]!)
    expect(await first).toBe('并发转写')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(child.terminated).toBe(false)

    child.respond(child.received[1]!)
    expect(await second).toBe('并发转写')
    await vi.waitFor(() => { expect(child.terminated).toBe(true) })
    await worker.dispose()
  })

  it('rejects an outstanding chunk on disposal without leaving an idle timer behind', async () => {
    const root = await localConfigRoot()
    const config = resolveConfig({
      asrMode: 'local',
      storageRoot: join(root, 'meetings'),
      localModelPath: join(root, 'model'),
      asrIdleShutdownMs: 20,
      timeZone: 'Asia/Shanghai',
    })
    const processes: FakeWorkerProcess[] = []
    const ctx = {
      subprocess: {
        resolveExecutable: (command: string) => Promise.resolve(command),
        spawn: () => {
          const child = new FakeWorkerProcess('未完成', true)
          processes.push(child)
          return child as unknown as SubprocessHandle
        },
      },
    } as unknown as Context
    const worker = new LocalAsrWorker(ctx, config)

    const pending = worker.transcribe('/tmp/chunk-0.wav', AbortSignal.timeout(5_000))
    await vi.waitFor(() => { expect(processes[0]?.received).toHaveLength(1) })
    const disposal = worker.dispose()
    await expect(pending).rejects.toThrow('local ASR worker disposed')
    await disposal
    expect(processes[0]!.terminated).toBe(true)
  })
})
