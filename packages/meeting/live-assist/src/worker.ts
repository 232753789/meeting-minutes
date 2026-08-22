/** Node-side driver for the persistent silero-vad + Qwen3-ASR Python process. */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { NdjsonWorker } from '@deepseek-ai/dsh-ndjson-worker'
import type { ResolvedConfig } from './config.ts'
import type { LiveSessionId } from './protocol.ts'

const WORKER_PATH = fileURLToPath(new URL('../python/live_asr_worker.py', import.meta.url))
const PROCESS_GRACE_MS = 10_000
const WORKER_DIAGNOSTIC_BYTES = 512 * 1024

/** One recognizer event addressed to a single open session. */
export type WorkerEvent =
  /** The counterpart started or stopped speaking. */
  | { readonly kind: 'speech'; readonly speaking: boolean }
  /** One completed utterance was transcribed; `text` may be empty. */
  | { readonly kind: 'utterance'; readonly index: number; readonly text: string; readonly seconds: number }
  /** Recognition failed for this session; the session may continue. */
  | { readonly kind: 'error'; readonly message: string }

/** Receives every recognizer event for one open session. */
export type WorkerListener = (event: WorkerEvent) => void

interface WorkerMessage {
  readonly type: string
  readonly session?: unknown
  readonly speaking?: unknown
  readonly index?: unknown
  readonly text?: unknown
  readonly seconds?: unknown
  readonly message?: unknown
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Decode one NDJSON line from the worker.
 * @param line - one complete stdout line.
 * @returns the decoded message envelope.
 */
export function parseWorkerMessage(line: string): WorkerMessage {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('live-assist: recognizer returned a non-object message')
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.type !== 'string') {
    throw new Error('live-assist: recognizer returned a message without a type')
  }
  return value as unknown as WorkerMessage
}

/**
 * One lazily started Python process shared by every open session.
 *
 * The process holds Qwen weights in device memory, so it is stopped once no session has been
 * open for `workerIdleShutdownMs`; the next session pays the load cost again. Sessions are
 * multiplexed by id: segmentation state is per session inside the worker, while transcription
 * is serial because the model runs at batch size one.
 */
export class LiveAsrWorker {
  private readonly process: NdjsonWorker
  private readonly listeners = new Map<LiveSessionId, WorkerListener>()
  private closed = false

  /**
   * @param ctx - plugin context owning the subprocess.
   * @param config - resolved recognizer settings frozen into the process arguments.
   */
  constructor(ctx: Context, config: ResolvedConfig) {
    this.process = new NdjsonWorker(ctx, {
      executable: config.pythonExecutable,
      args: [
        WORKER_PATH,
        '--model', config.localModelPath,
        '--device', config.localDevice,
        '--language', config.language,
        '--max-new-tokens', String(config.asrMaxOutputTokens),
        '--vad-threshold', String(config.vadThreshold),
        '--min-silence-ms', String(config.vadMinSilenceMs),
        '--speech-pad-ms', String(config.vadSpeechPadMs),
        '--min-utterance-ms', String(config.minUtteranceMs),
        '--max-utterance-ms', String(config.maxUtteranceMs),
      ],
      cwd: dirname(WORKER_PATH),
      label: 'live-assist: recognizer',
      idleShutdownMs: config.workerIdleShutdownMs,
      graceMs: PROCESS_GRACE_MS,
      diagnosticBytes: WORKER_DIAGNOSTIC_BYTES,
    }, {
      onLine: (line) => { this.onLine(line) },
      onFailure: (error) => { this.failAll(error.message) },
      isIdle: () => this.listeners.size === 0,
    })
  }

  private failAll(message: string): void {
    for (const listener of [...this.listeners.values()]) listener({ kind: 'error', message })
  }

  private onLine(line: string): void {
    let message: WorkerMessage
    try {
      message = parseWorkerMessage(line)
    } catch (error) {
      this.failAll(asError(error).message)
      void this.process.stop()
      return
    }
    // A worker-level failure (a missing dependency, a model that will not load) carries no
    // session, so it reaches every open session rather than being dropped.
    if (message.session === null || message.session === undefined) {
      if (message.type === 'error') this.failAll(String(message.message))
      return
    }
    const listener = this.listeners.get(message.session as LiveSessionId)
    if (listener === undefined) return
    if (message.type === 'speech') {
      listener({ kind: 'speech', speaking: message.speaking === true })
      return
    }
    if (message.type === 'utterance') {
      if (typeof message.index !== 'number' || typeof message.text !== 'string' || typeof message.seconds !== 'number') {
        listener({ kind: 'error', message: 'live-assist: recognizer returned a malformed utterance' })
        return
      }
      listener({ kind: 'utterance', index: message.index, text: message.text, seconds: message.seconds })
      return
    }
    if (message.type === 'error') listener({ kind: 'error', message: String(message.message) })
  }

  /** Sessions currently multiplexed onto the recognizer. */
  get openSessions(): number {
    return this.listeners.size
  }

  /**
   * Open one segmentation context, starting the process when this is the first session.
   * @param session - caller-minted session id.
   * @param listener - receives every recognizer event for this session.
   */
  async open(session: LiveSessionId, listener: WorkerListener): Promise<void> {
    if (this.closed) throw new Error('live-assist: recognizer is closed')
    this.process.clearIdleShutdown()
    this.listeners.set(session, listener)
    try {
      await this.process.ensureStarted()
    } catch (error) {
      this.listeners.delete(session)
      this.process.armIdleShutdown()
      throw error
    }
    this.process.write({ type: 'start', session })
  }

  /**
   * Forward one PCM frame; frames for an unopened session are dropped.
   * @param session - session the audio belongs to.
   * @param pcm - little-endian 16-bit mono samples at {@link PCM_SAMPLE_RATE}.
   */
  push(session: LiveSessionId, pcm: Buffer): void {
    if (this.closed || !this.process.running || !this.listeners.has(session)) return
    this.process.write({ type: 'audio', session, pcm: pcm.toString('base64') })
  }

  /**
   * Discard one session's segmentation context and arm idle shutdown when it was the last.
   * @param session - session to close.
   */
  close(session: LiveSessionId): void {
    if (!this.listeners.delete(session)) return
    if (!this.closed && this.process.running) this.process.write({ type: 'stop', session })
    this.process.armIdleShutdown()
  }

  /** Stop the worker and await process-tree quiescence. */
  async dispose(): Promise<void> {
    this.closed = true
    this.listeners.clear()
    await this.process.dispose()
  }
}
