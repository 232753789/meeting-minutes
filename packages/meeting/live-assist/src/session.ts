/** One live recognizer session: counterpart audio in, session events out. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'
import { generateAnswer, type QaTurn } from './answer.ts'
import { generateTitle } from './title.ts'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from './events.ts'
import { UtteranceId, type LiveSessionId, type ServerMessage } from './protocol.ts'
import type { LiveAsrWorker, WorkerEvent } from './worker.ts'

/** Shortest transcript that is worth triaging; below it the model would only see a filler word. */
const MIN_TRANSCRIPT_LENGTH = 2

/**
 * The interviewee's own typed messages in this session, oldest first.
 *
 * Everything this plugin appends is non-surface, so a `user/message` in an interview session is
 * necessarily something the interviewee typed — a correction or an instruction for the answers
 * that follow ("重点说 Redis"), which is exactly what should steer them.
 * @param target - the session carrying the interview.
 * @param limit - newest messages to keep.
 * @returns the message texts, oldest first.
 */
export function intervieweeNotes(target: Session, limit: number): string[] {
  if (limit === 0) return []
  const notes: string[] = []
  for (const event of target.events) {
    if (event.type !== 'user/message') continue
    const content = (event.data as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type: 'text'; text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text)
      .join('')
      .trim()
    if (text !== '') notes.push(text)
  }
  return notes.slice(-limit)
}

/** Sends one live status message to the browser panel; a closed socket drops it. */
export type Sender = (message: ServerMessage) => void

/**
 * Owns one panel's recognizer and writes everything it produces into a dsh session.
 *
 * Transcripts and answers are session events, so the conversation view renders them through the
 * ordinary session path and they survive a reload. The socket carries only live status the log
 * has no reason to keep.
 *
 * Every utterance gets its own answer. They are generated one at a time, in the order they were
 * heard, because each request carries the answers before it as history. A newer question never
 * cancels the one being answered: the recognizer splits on silence, so a pause mid-sentence can
 * end an utterance early, and cancelling would throw away the answer to the real question and
 * leave only the fragment that followed it.
 */
export class LiveSession {
  private readonly history: QaTurn[] = []
  private readonly lifetime = new AbortController()
  private tail: Promise<void> = Promise.resolve()
  private background = ''
  private paused = false
  private opened = false
  private closed = false

  /**
   * @param ctx - plugin context with LLM services.
   * @param config - resolved plugin configuration.
   * @param worker - recognizer this session multiplexes onto.
   * @param id - recognizer-session id minted by the socket route.
   * @param send - delivers one live status message to the browser panel.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly worker: LiveAsrWorker,
    private readonly id: LiveSessionId,
    private readonly send: Sender,
  ) {}

  /**
   * Open the recognizer against `target` and accept audio.
   * @param background - the interviewee's own material, already length-checked by the caller.
   * @param target - the dsh session every transcript and answer is appended to.
   */
  async start(background: string, target: Session): Promise<void> {
    if (this.closed || this.opened) return
    this.opened = true
    this.background = background
    target.append('live-assist/started', { background })
    await this.nameSession(target, background)
    // Naming is awaited, so the panel can close the socket while a start is still in it. Read the
    // lifetime rather than `closed`, exactly as a queued answer does.
    if (this.lifetime.signal.aborted) return
    await this.worker.open(this.id, (event) => { this.onWorkerEvent(target, event) })
    this.send({ type: 'ready', recognizer: this.id })
  }

  /**
   * Name the session after the background material before the recognizer opens.
   *
   * The title request runs to completion first, so the session carries its name from its first
   * frame and the conversation is identifiable in the list before a single word is transcribed.
   * The cost is start latency: the panel stays on its connecting state for one model request,
   * during which the counterpart is not yet being listened to.
   *
   * A name is not worth failing a start over, so an unavailable `sessionTitle` service, a title
   * the model declined to produce, and a failed request all leave the default name and continue
   * to the recognizer.
   */
  private async nameSession(target: Session, background: string): Promise<void> {
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) return
    try {
      const title = await generateTitle(this.ctx, this.config, background, this.lifetime.signal)
      if (title === undefined) return
      // Renaming a session that is no longer live throws; a title that lost the race is dropped.
      if (this.lifetime.signal.aborted) return
      titles.rename(target, title)
    } catch (error) {
      // Disposal aborts the request in flight, exactly as it does an answer; a naming cancelled
      // by the session ending is not a failure worth reporting.
      if (this.lifetime.signal.aborted) return
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Forward one PCM frame unless the panel paused the session.
   * @param pcm - little-endian 16-bit mono samples.
   */
  pushAudio(pcm: Buffer): void {
    if (this.closed || this.paused || !this.opened) return
    this.worker.push(this.id, pcm)
  }

  /** Stop forwarding audio; the recognizer keeps this session's segmentation state. */
  pause(): void {
    this.paused = true
  }

  /** Resume forwarding audio. */
  resume(): void {
    this.paused = false
  }

  private onWorkerEvent(target: Session, event: WorkerEvent): void {
    if (this.closed) return
    if (event.kind === 'speech') {
      this.send({ type: 'speech', speaking: event.speaking })
      return
    }
    if (event.kind === 'error') {
      this.send({ type: 'error', message: event.message, fatal: false })
      return
    }
    const id = UtteranceId(`${this.id}-${String(event.index)}`)
    const text = event.text.trim()
    target.append('live-assist/utterance', { id, text, seconds: event.seconds })
    if (text === '') {
      target.append('live-assist/skipped', { id, reason: 'empty-transcript' })
      return
    }
    if (text.length < MIN_TRANSCRIPT_LENGTH) {
      target.append('live-assist/skipped', { id, reason: 'too-short' })
      return
    }
    this.answer(target, id, text)
  }

  private answer(target: Session, id: UtteranceId, question: string): void {
    const signal = this.lifetime.signal
    this.tail = this.tail.then(async () => {
      // The queue outlives the session's own teardown, so entries that never started are dropped.
      if (signal.aborted) return
      let answer = ''
      try {
        const events = generateAnswer(
          this.ctx,
          this.config,
          {
            background: this.background,
            history: this.history,
            notes: intervieweeNotes(target, this.config.noteTurns),
            question,
          },
          signal,
        )
        for await (const event of events) {
          if (event.kind === 'skip') {
            target.append('live-assist/skipped', { id, reason: 'not-a-question' })
            return
          }
          if (event.kind === 'start') {
            target.append('live-assist/answer-start', { id })
            continue
          }
          answer += event.text
          target.append('live-assist/answer-delta', { id, text: event.text })
        }
        target.append('live-assist/answer-end', { id })
        this.history.push({ question, answer })
        if (this.history.length > this.config.historyTurns) this.history.shift()
      } catch (error) {
        // Disposal aborts the request in flight, and `generateAnswer` reports that as a throw
        // before it can yield again, so cancellation is handled here and nowhere else. Read the
        // controller rather than the captured signal: the entry guard above narrows that one.
        if (this.lifetime.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        this.send({ type: 'error', message, fatal: false })
      }
    })
  }

  /** Await every answer this session started. */
  settled(): Promise<void> {
    return this.tail
  }

  /** Abort answer generation, release the recognizer context, and reach quiescence. */
  async dispose(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    this.worker.close(this.id)
    await this.tail
  }
}
