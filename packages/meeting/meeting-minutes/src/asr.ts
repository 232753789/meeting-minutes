/** Local persistent qwen-asr worker and remote OpenAI-compatible ASR driver. */

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { ResolvedConfig } from './config.ts'

const WORKER_PATH = fileURLToPath(new URL('../python/asr_worker.py', import.meta.url))
const PROCESS_GRACE_MS = 10_000
const WORKER_DIAGNOSTIC_BYTES = 512 * 1024
const ASR_TIMEOUT_CODE = 'MEETING_MINUTES_ASR_TIMEOUT'

interface PendingRequest {
  resolve(text: string): void
  reject(error: Error): void
}

interface WorkerResponse {
  id: number
  ok: boolean
  text?: string
  error?: string
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function parseWorkerResponse(line: string): WorkerResponse {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('meeting-minutes: ASR worker returned a non-object response')
  }
  const value = parsed as Record<string, unknown>
  if (!Number.isInteger(value.id) || typeof value.ok !== 'boolean') {
    throw new Error('meeting-minutes: ASR worker returned an invalid response envelope')
  }
  if (value.ok && typeof value.text !== 'string') {
    throw new Error('meeting-minutes: ASR worker returned no transcript text')
  }
  if (!value.ok && typeof value.error !== 'string') {
    throw new Error('meeting-minutes: ASR worker returned no error message')
  }
  return value as unknown as WorkerResponse
}

/**
 * One lazily started Python process that retains Qwen weights between chunks and meetings.
 *
 * The process holds the whole model in device memory, so it is terminated once no request has been
 * outstanding for `asrIdleShutdownMs`; the next chunk pays the load cost again through the same
 * lazy start.
 */
export class LocalAsrWorker {
  private handle: SubprocessHandle | undefined
  private lines: ReadlineInterface | undefined
  private starting: Promise<SubprocessHandle> | undefined
  private stopping: Promise<void> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closed = false

  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  private clearIdleShutdown(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Start the idle countdown once a live process owes nothing; unref'd so it never holds the loop open. */
  private armIdleShutdown(): void {
    this.clearIdleShutdown()
    if (this.closed || this.handle === undefined || this.pending.size > 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.stopCurrent()
    }, this.config.asrIdleShutdownMs)
    this.idleTimer.unref()
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
      void this.stopCurrent()
      return
    }
    const pending = this.pending.get(response.id)
    if (pending === undefined) return
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.text as string)
    else pending.reject(new Error(`meeting-minutes: local ASR failed: ${response.error as string}`))
  }

  private async start(): Promise<SubprocessHandle> {
    if (this.closed) throw new Error('meeting-minutes: local ASR worker is closed')
    if (this.stopping !== undefined) await this.stopping
    if (this.handle !== undefined) return this.handle
    this.starting ??= (async () => {
      const python = await this.ctx.subprocess.resolveExecutable(this.config.pythonExecutable)
      const handle = this.ctx.subprocess.spawn({
        argv: [
          python,
          WORKER_PATH,
          '--model', this.config.localModelPath,
          '--device', this.config.localDevice,
          '--max-new-tokens', String(this.config.asrMaxOutputTokens),
        ],
        cwd: dirname(WORKER_PATH),
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: WORKER_DIAGNOSTIC_BYTES },
        },
        graceMs: PROCESS_GRACE_MS,
      })
      if (handle.stdin === undefined || handle.stdout === undefined) {
        handle.terminate()
        await handle.waitForExit()
        throw new Error('meeting-minutes: local ASR worker did not expose piped stdio')
      }
      const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
      lines.on('line', (line) => { this.onLine(line) })
      this.lines = lines
      this.handle = handle
      void handle.done.then((outcome) => {
        if (this.handle !== handle) return
        this.clearIdleShutdown()
        this.lines?.close()
        this.lines = undefined
        this.handle = undefined
        const stderr = handle.collected.stderr?.readFrom(0).text.trim()
        this.rejectPending(new Error(
          `meeting-minutes: local ASR worker exited with ${String(outcome.exitCode)}`
          + (stderr === undefined || stderr === '' ? '' : `: ${stderr}`),
        ))
      }, (error: unknown) => {
        if (this.handle !== handle) return
        this.clearIdleShutdown()
        this.lines?.close()
        this.lines = undefined
        this.handle = undefined
        this.rejectPending(asError(error))
      })
      return handle
    })()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private stopCurrent(): Promise<void> {
    this.clearIdleShutdown()
    if (this.stopping !== undefined) return this.stopping
    const handle = this.handle
    if (handle === undefined) return Promise.resolve()
    this.handle = undefined
    this.lines?.close()
    this.lines = undefined
    this.stopping = (async () => {
      handle.terminate()
      await handle.waitForExit()
    })().finally(() => { this.stopping = undefined })
    return this.stopping
  }

  /**
   * Transcribe one WAV chunk, terminating the process when cancellation wins.
   * @param audioPath - absolute path to the normalized WAV chunk.
   * @param signal - caller cancellation for inference and worker teardown.
   * @returns the non-empty transcript text.
   */
  async transcribe(audioPath: string, signal: AbortSignal): Promise<string> {
    this.clearIdleShutdown()
    const handle = await this.start()
    using requestDeadline = deadline(signal, this.config.asrRequestTimeoutMs, ASR_TIMEOUT_CODE)
    requestDeadline.signal.throwIfAborted()
    const id = this.nextId++
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        requestDeadline.signal.removeEventListener('abort', onAbort)
        this.armIdleShutdown()
        callback()
      }
      const onAbort = (): void => {
        this.pending.delete(id)
        finish(() => { reject(asError(requestDeadline.signal.reason)) })
        void this.stopCurrent()
      }
      this.pending.set(id, {
        resolve: (text) => { finish(() => { resolve(text) }) },
        reject: (error) => { finish(() => { reject(error) }) },
      })
      requestDeadline.signal.addEventListener('abort', onAbort, { once: true })
      const request = JSON.stringify({ id, audio: audioPath, language: this.config.language })
      handle.stdin?.write(`${request}\n`, (error) => {
        if (error === null || error === undefined) return
        this.pending.delete(id)
        finish(() => { reject(error) })
        void this.stopCurrent()
      })
    })
  }

  /** Stop the worker and await process-tree quiescence. */
  async dispose(): Promise<void> {
    this.closed = true
    this.clearIdleShutdown()
    this.rejectPending(new Error('meeting-minutes: local ASR worker disposed'))
    try {
      await this.starting
    } catch {
      // A failed start owns no live process; the caller is already disposing.
    }
    await this.stopCurrent()
  }
}

function remoteText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const texts = value.map((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return undefined
    const candidate = block as Record<string, unknown>
    return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : undefined
  })
  return texts.every(text => text !== undefined) ? texts.join('') : undefined
}

/**
 * Send one WAV chunk to a qwen-asr-serve/vLLM chat-completions endpoint.
 * @param config - resolved remote route, token limit, language, and timeout.
 * @param audioPath - absolute path to the normalized WAV chunk.
 * @param signal - caller cancellation for file reading and HTTP transport.
 * @returns the non-empty transcript text.
 */
export async function transcribeRemote(
  config: ResolvedConfig,
  audioPath: string,
  signal: AbortSignal,
): Promise<string> {
  using requestDeadline = deadline(signal, config.asrRequestTimeoutMs, ASR_TIMEOUT_CODE)
  const audio = await readFile(audioPath)
  requestDeadline.signal.throwIfAborted()
  const key = process.env[config.remoteApiKeyEnv]
  const response = await fetch(config.remoteEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({
      model: config.remoteModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${audio.toString('base64')}` } },
          { type: 'text', text: `Transcribe this audio. Language: ${config.language}. Return only the transcript.` },
        ],
      }],
      temperature: 0,
      max_tokens: config.asrMaxOutputTokens,
    }),
    signal: requestDeadline.signal,
  })
  const body: unknown = await response.json()
  if (!response.ok) {
    throw new Error(`meeting-minutes: remote ASR returned HTTP ${String(response.status)}: ${JSON.stringify(body)}`)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('meeting-minutes: remote ASR returned a non-object response')
  }
  const choices = (body as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('meeting-minutes: remote ASR returned no choices')
  }
  const choice: unknown = choices[0]
  const message = typeof choice === 'object' && choice !== null && !Array.isArray(choice)
    ? (choice as Record<string, unknown>).message
    : undefined
  const content = typeof message === 'object' && message !== null && !Array.isArray(message)
    ? (message as Record<string, unknown>).content
    : undefined
  const text = remoteText(content)?.trim()
  if (text === undefined || text === '') throw new Error('meeting-minutes: remote ASR returned no transcript text')
  return text
}
