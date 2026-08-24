/** Local pyannote speaker-diarization worker and interval validation. */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { NdjsonWorker } from '@deepseek-ai/dsh-ndjson-worker'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { ResolvedConfig } from './config.ts'
import type { SpeakerId } from './types.ts'

const WORKER_PATH = fileURLToPath(new URL('../python/diarization_worker.py', import.meta.url))
const PROCESS_GRACE_MS = 10_000
const WORKER_DIAGNOSTIC_BYTES = 512 * 1024
const DIARIZATION_TIMEOUT_CODE = 'MEETING_MINUTES_DIARIZATION_TIMEOUT'

/** One speaker-labelled time interval from the diarization provider. */
export interface SpeakerInterval {
  readonly startSeconds: number
  readonly endSeconds: number
  readonly speaker: SpeakerId
}

interface PendingRequest {
  resolve(intervals: readonly SpeakerInterval[]): void
  reject(error: Error): void
}

interface WorkerResponse {
  id: number
  ok: boolean
  intervals?: unknown
  error?: string
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function validInterval(value: unknown): SpeakerInterval | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.startSeconds !== 'number' || !Number.isFinite(candidate.startSeconds)) return undefined
  if (typeof candidate.endSeconds !== 'number' || !Number.isFinite(candidate.endSeconds)) return undefined
  if (candidate.endSeconds <= candidate.startSeconds) return undefined
  if (typeof candidate.speaker !== 'string' || !/^speaker-[0-9]+$/u.test(candidate.speaker)) return undefined
  return candidate as unknown as SpeakerInterval
}

function parseWorkerResponse(line: string): WorkerResponse {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('meeting-minutes: diarization worker returned a non-object response')
  }
  const value = parsed as Record<string, unknown>
  if (!Number.isInteger(value.id) || typeof value.ok !== 'boolean') {
    throw new Error('meeting-minutes: diarization worker returned an invalid response envelope')
  }
  if (value.ok) {
    if (!Array.isArray(value.intervals) || value.intervals.some(interval => validInterval(interval) === undefined)) {
      throw new Error('meeting-minutes: diarization worker returned invalid intervals')
    }
  } else if (typeof value.error !== 'string') {
    throw new Error('meeting-minutes: diarization worker returned no error message')
  }
  return value as unknown as WorkerResponse
}

/**
 * Validate and sort diarization intervals before they are used to select audio ranges.
 * @param intervals - untrusted worker output.
 * @returns ordered valid intervals, or an empty list when no speaker was detected.
 */
export function normalizeSpeakerIntervals(intervals: readonly unknown[]): SpeakerInterval[] {
  const valid = intervals.flatMap((interval) => {
    const parsed = validInterval(interval)
    return parsed === undefined ? [] : [parsed]
  })
  return valid.sort((left, right) => left.startSeconds - right.startSeconds)
}

/**
 * One lazily started pyannote process that keeps the diarization pipeline loaded.
 * @param ctx - context owning the subprocess.
 * @param config - resolved diarization settings.
 */
export class LocalSpeakerWorker {
  private readonly process: NdjsonWorker
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closed = false

  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    this.process = new NdjsonWorker(ctx, {
      executable: config.pythonExecutable,
      args: [
        WORKER_PATH,
        '--model', config.speakerModelPath,
        '--device', config.localDevice,
      ],
      cwd: dirname(WORKER_PATH),
      label: 'meeting-minutes: speaker diarization worker',
      idleShutdownMs: config.speakerIdleShutdownMs,
      graceMs: PROCESS_GRACE_MS,
      diagnosticBytes: WORKER_DIAGNOSTIC_BYTES,
    }, {
      onLine: (line) => { this.onLine(line) },
      onFailure: (error) => { this.rejectPending(error) },
      isIdle: () => this.pending.size === 0,
    })
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private onLine(line: string): void {
    let response: WorkerResponse
    try {
      response = parseWorkerResponse(line)
    } catch (error) {
      this.rejectPending(asError(error))
      void this.process.stop()
      return
    }
    const pending = this.pending.get(response.id)
    if (pending === undefined) return
    this.pending.delete(response.id)
    if (!response.ok) {
      pending.reject(new Error(`meeting-minutes: diarization failed: ${response.error as string}`))
      return
    }
    pending.resolve(normalizeSpeakerIntervals(response.intervals as unknown[]))
  }

  /**
   * Diarize one complete normalized recording.
   * @param audioPath - absolute normalized audio path.
   * @param signal - cancellation for inference and worker teardown.
   * @returns ordered speaker intervals.
   */
  async diarize(audioPath: string, signal: AbortSignal): Promise<readonly SpeakerInterval[]> {
    if (this.closed) throw new Error('meeting-minutes: speaker worker is closed')
    this.process.clearIdleShutdown()
    await this.process.ensureStarted()
    using requestDeadline = deadline(signal, this.config.speakerRequestTimeoutMs, DIARIZATION_TIMEOUT_CODE)
    requestDeadline.signal.throwIfAborted()
    const id = this.nextId++
    return await new Promise<readonly SpeakerInterval[]>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        requestDeadline.signal.removeEventListener('abort', onAbort)
        this.process.armIdleShutdown()
        callback()
      }
      const onAbort = (): void => {
        this.pending.delete(id)
        finish(() => { reject(asError(requestDeadline.signal.reason)) })
        void this.process.stop()
      }
      this.pending.set(id, {
        resolve: (intervals) => { finish(() => { resolve(intervals) }) },
        reject: (error) => { finish(() => { reject(error) }) },
      })
      requestDeadline.signal.addEventListener('abort', onAbort, { once: true })
      this.process.write({ id, audio: audioPath })
    })
  }

  /** Stop the worker and await process-tree quiescence. */
  async dispose(): Promise<void> {
    this.closed = true
    this.rejectPending(new Error('meeting-minutes: speaker worker disposed'))
    await this.process.dispose()
  }
}
