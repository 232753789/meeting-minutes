import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { LocalSpeakerWorker, normalizeSpeakerIntervals } from '../src/speaker.ts'

class FakeSpeakerProcess {
  readonly pid = 4243
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected = { stderr: undefined } as unknown as SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  terminated = false
  private settle!: (outcome: SubprocessOutcome) => void

  constructor() {
    this.done = new Promise<SubprocessOutcome>((resolve) => { this.settle = resolve })
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        const request = JSON.parse(line) as { id: number }
        this.stdout.write(`${JSON.stringify({
          id: request.id,
          ok: true,
          intervals: [
            { startSeconds: 0, endSeconds: 1.2, speaker: 'speaker-1' },
            { startSeconds: 1.2, endSeconds: 2.4, speaker: 'speaker-2' },
          ],
        })}\n`)
      }
    })
  }

  terminate(): void {
    this.terminated = true
    this.settle({ exitCode: null, signal: 'SIGTERM' })
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

describe('speaker diarization', () => {
  it('sorts valid intervals and drops malformed worker output', () => {
    expect(normalizeSpeakerIntervals([
      { startSeconds: 2, endSeconds: 3, speaker: 'speaker-2' },
      { startSeconds: 0, endSeconds: 1, speaker: 'speaker-1' },
      { startSeconds: 1, endSeconds: 1, speaker: 'speaker-3' },
      { startSeconds: 3, endSeconds: 4, speaker: 'unknown' },
    ])).toEqual([
      { startSeconds: 0, endSeconds: 1, speaker: 'speaker-1' },
      { startSeconds: 2, endSeconds: 3, speaker: 'speaker-2' },
    ])
  })

  it('keeps one process alive for a request and disposes it', async () => {
    const modelPath = await mkdtemp(join(tmpdir(), 'pyannote-model-'))
    const storageRoot = await mkdtemp(join(tmpdir(), 'meeting-minutes-speaker-'))
    await mkdir(storageRoot, { recursive: true })
    const config = resolveConfig({
      asrMode: 'remote',
      storageRoot,
      speakerMode: 'pyannote',
      speakerModelPath: modelPath,
      speakerIdleShutdownMs: 60_000,
      timeZone: 'Asia/Shanghai',
    })
    const processes: FakeSpeakerProcess[] = []
    const ctx = {
      subprocess: {
        resolveExecutable: (command: string) => Promise.resolve(command),
        spawn: (_spec: SubprocessSpawnSpec) => {
          const process = new FakeSpeakerProcess()
          processes.push(process)
          return process as unknown as SubprocessHandle
        },
      },
    } as unknown as Context
    const worker = new LocalSpeakerWorker(ctx, config)

    await expect(worker.diarize('/tmp/meeting.mp4', AbortSignal.timeout(5_000))).resolves.toEqual([
      { startSeconds: 0, endSeconds: 1.2, speaker: 'speaker-1' },
      { startSeconds: 1.2, endSeconds: 2.4, speaker: 'speaker-2' },
    ])
    expect(processes).toHaveLength(1)
    await worker.dispose()
    expect(processes[0]!.terminated).toBe(true)
  })
})
