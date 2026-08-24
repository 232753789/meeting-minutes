/** Serial meeting-processing lifecycle and teardown ownership. */

import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { transcribeRemote, LocalAsrWorker } from './asr.ts'
import type { ResolvedConfig } from './config.ts'
import { normalizeAndChunk } from './ffmpeg.ts'
import {
  availableMinutesFilename,
  listMeetings,
  meetingDisplayName,
  readCompletedTranscript,
  readRecord,
  readSummaryRequests,
  readTranscriptProgress,
  removeMeeting,
  removeResumableProgress,
  removeTranscriptProgress,
  renderMinutes,
  resumeStage,
  statusOf,
  transcriptFullText,
  updateRecord,
  writeMeetingText,
  writeTranscript,
  writeTranscriptProgress,
} from './storage.ts'
import { summarizeMeeting, type MeetingSummary } from './summary.ts'
import type {
  MeetingId,
  MeetingListEntry,
  MeetingRecord,
  MeetingRetryMode,
  MeetingStatus,
  TranscriptSegment,
} from './types.ts'

/** Everything the summary and Markdown stages need, whether transcribed now or reused. */
interface TranscribedMeeting {
  readonly audioFilename: string
  readonly json: string
  readonly text: string
  readonly fullText: string
  readonly segments: readonly TranscriptSegment[]
}

interface RuntimeOperations {
  normalize: typeof normalizeAndChunk
  remoteAsr: typeof transcribeRemote
  summarize: typeof summarizeMeeting
}

/** Result of admitting one durable meeting for another processing attempt. */
export type MeetingRetryResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict' }

/** Result of permanently deleting one stored meeting. */
export type MeetingRemoveResult =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict' }

const DEFAULT_OPERATIONS: RuntimeOperations = {
  normalize: normalizeAndChunk,
  remoteAsr: transcribeRemote,
  summarize: summarizeMeeting,
}

/** Owns one serialized processing queue plus the persistent local model worker. */
export class MeetingMinutesRuntime {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<MeetingId>()
  private readonly admissions = new Set<Promise<unknown>>()
  private readonly localWorker: LocalAsrWorker | undefined
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly ctx: Context,
    readonly config: ResolvedConfig,
    private readonly operations: RuntimeOperations = DEFAULT_OPERATIONS,
  ) {
    this.localWorker = config.asrMode === 'local' ? new LocalAsrWorker(ctx, config) : undefined
  }

  /**
   * Enqueue a fully persisted upload; ASR work stays single-file for the 1.7B model.
   * @param record - mutable durable record owned by the queued operation.
   * @throws When the runtime is closing or already owns the meeting id.
   */
  enqueue(record: MeetingRecord): void {
    if (this.closed) throw new Error('meeting-minutes: runtime is closing')
    if (this.active.has(record.id)) throw new Error(`meeting-minutes: ${record.id} is already active`)
    this.active.add(record.id)
    this.enqueueClaimed(record)
  }

  private enqueueClaimed(record: MeetingRecord): void {
    const run = this.tail.then(async () => {
      try {
        await this.process(record, this.lifetime.signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await updateRecord(this.config, record, { stage: 'failed', error: message })
        this.ctx.logger.warn(error instanceof Error ? error : new Error(message))
      } finally {
        this.active.delete(record.id)
      }
    })
    this.tail = run.catch(() => {})
  }

  /**
   * Project the newest stored meetings for the browser history list.
   *
   * An interrupted record is reported as failed without writing; {@link status} owns that durable
   * transition when the meeting is opened.
   *
   * @returns newest-first history rows.
   * @throws When the storage root cannot be read.
   */
  async list(): Promise<MeetingListEntry[]> {
    const records = await listMeetings(this.config)
    return records.map(record => ({
      id: record.id,
      stage: this.interrupted(record) ? 'failed' : record.stage,
      name: meetingDisplayName(record),
      createdAt: record.createdAt,
    }))
  }

  /**
   * Admit a durable complete or failed meeting for another attempt at its preserved original upload.
   * @param id - validated meeting identifier.
   * @param mode - whether the attempt resumes at the failed stage or reruns the complete chain.
   * @returns whether the retry was accepted, missing, or incompatible with current state.
   * @throws When the runtime is closing or durable metadata cannot be read or updated.
   */
  retry(id: MeetingId, mode: MeetingRetryMode): Promise<MeetingRetryResult> {
    if (this.closed) return Promise.reject(new Error('meeting-minutes: runtime is closing'))
    if (this.active.has(id)) return Promise.resolve({ kind: 'conflict' })
    this.active.add(id)
    const operation = this.admitRetry(id, mode)
    this.admissions.add(operation)
    void operation.finally(() => { this.admissions.delete(operation) }).catch(() => {})
    return operation
  }

  /**
   * Permanently delete one stored meeting and every artifact in its directory.
   *
   * The id is claimed synchronously so a concurrent retry or delete cannot run against a
   * directory that is being removed; a meeting owned by the processing queue is refused.
   *
   * @param id - validated meeting identifier.
   * @returns whether the meeting was deleted, missing, or still active.
   * @throws When the runtime is closing or the directory cannot be read or removed.
   */
  remove(id: MeetingId): Promise<MeetingRemoveResult> {
    if (this.closed) return Promise.reject(new Error('meeting-minutes: runtime is closing'))
    if (this.active.has(id)) return Promise.resolve({ kind: 'conflict' })
    this.active.add(id)
    const operation = this.removeClaimed(id)
    this.admissions.add(operation)
    void operation.finally(() => { this.admissions.delete(operation) }).catch(() => {})
    return operation
  }

  private async removeClaimed(id: MeetingId): Promise<MeetingRemoveResult> {
    try {
      const record = await readRecord(this.config, id)
      if (record === undefined) return { kind: 'missing' }
      await removeMeeting(this.config, id)
      return { kind: 'deleted' }
    } finally {
      this.active.delete(id)
    }
  }

  private async admitRetry(id: MeetingId, mode: MeetingRetryMode): Promise<MeetingRetryResult> {
    let enqueued = false
    try {
      const record = await readRecord(this.config, id)
      if (record === undefined) return { kind: 'missing' }
      if (record.stage !== 'failed' && record.stage !== 'complete') return { kind: 'conflict' }
      if (this.closed) throw new Error('meeting-minutes: runtime is closing')
      // The same judgement the status projection published, so the browser's choice of button and
      // the work this attempt skips agree; a complete meeting has no failed stage to resume at.
      const resuming = mode === 'resume' && resumeStage(record) !== undefined
      if (!resuming) {
        await removeResumableProgress(this.config, id)
        delete record.totalChunks
        delete record.normalizedAudio
        delete record.transcriptJson
        delete record.transcriptText
      }
      delete record.topic
      delete record.summaryMarkdown
      delete record.minutesFilename
      delete record.error
      await updateRecord(this.config, record, {
        stage: 'queued',
        ...(resuming ? {} : { completedChunks: 0 }),
      })
      if (this.lifetime.signal.aborted) {
        await updateRecord(this.config, record, {
          stage: 'failed',
          error: 'meeting-minutes: retry was interrupted before processing began',
        })
        throw new Error('meeting-minutes: runtime is closing')
      }
      this.enqueueClaimed(record)
      enqueued = true
      return { kind: 'accepted' }
    } finally {
      if (!enqueued) this.active.delete(id)
    }
  }

  private async transcribe(path: string, signal: AbortSignal): Promise<string> {
    if (this.config.asrMode === 'remote') {
      return await this.operations.remoteAsr(this.config, path, signal)
    }
    if (this.localWorker === undefined) throw new Error('meeting-minutes: local ASR worker is unavailable')
    return await this.localWorker.transcribe(path, signal)
  }

  /**
   * Produce the transcript, transcribing only the chunks no previous attempt completed.
   *
   * A meeting whose transcript is already published skips normalization and ASR entirely. Otherwise
   * the WAV chunks are cut again — they are temporary — and the chunks a previous attempt already
   * transcribed are read back from the progress file instead of being sent to the model again.
   */
  private async transcribed(record: MeetingRecord, signal: AbortSignal): Promise<TranscribedMeeting> {
    const completed = await readCompletedTranscript(this.config, record)
    if (completed !== undefined) {
      return { ...completed, fullText: transcriptFullText(completed.segments) }
    }
    await updateRecord(this.config, record, { stage: 'normalizing' })
    const normalized = await this.operations.normalize(this.ctx, this.config, record, signal)
    const segments: TranscriptSegment[] = await readTranscriptProgress(
      this.config,
      record.id,
      normalized.chunks.length,
    )
    const resumed = segments.length
    await updateRecord(this.config, record, {
      normalizedAudio: normalized.audioFilename,
      totalChunks: normalized.chunks.length,
      completedChunks: resumed,
      stage: 'transcribing',
    })
    try {
      for (const [offset, chunk] of normalized.chunks.slice(resumed).entries()) {
        signal.throwIfAborted()
        const index = resumed + offset
        const text = await this.transcribe(chunk, signal)
        segments.push({ index, startSeconds: index * this.config.asrChunkSeconds, text })
        await writeTranscriptProgress(this.config, record.id, segments)
        await updateRecord(this.config, record, { completedChunks: segments.length })
      }
      const transcript = await writeTranscript(this.config, record.id, segments)
      await removeTranscriptProgress(this.config, record.id)
      return { audioFilename: normalized.audioFilename, segments, ...transcript }
    } finally {
      await rm(normalized.chunkDirectory, { recursive: true, force: true })
    }
  }

  private async process(record: MeetingRecord, signal: AbortSignal): Promise<void> {
    const transcribed = await this.transcribed(record, signal)
    await updateRecord(this.config, record, {
      stage: 'summarizing',
      transcriptJson: transcribed.json,
      transcriptText: transcribed.text,
    })
    const summary: MeetingSummary = await this.operations.summarize(
      this.ctx,
      this.config,
      record.id,
      transcribed.fullText,
      signal,
      await readSummaryRequests(this.config, record.id),
    )
    const minutesFilename = await availableMinutesFilename(this.config, record, summary.topic)
    await writeMeetingText(
      this.config,
      record.id,
      minutesFilename,
      renderMinutes(
        record,
        transcribed.audioFilename,
        summary.topic,
        summary.summaryMarkdown,
        transcribed.segments,
      ),
    )
    await updateRecord(this.config, record, {
      stage: 'complete',
      topic: summary.topic,
      summaryMarkdown: summary.summaryMarkdown,
      minutesFilename,
    })
  }

  /**
   * Read status and convert a pre-restart nonterminal record into a durable failure.
   * @param id - validated meeting identifier.
   * @returns browser-facing status, or undefined when the record does not exist.
   */
  async status(id: MeetingId): Promise<MeetingStatus | undefined> {
    const record = await readRecord(this.config, id)
    if (record === undefined) return undefined
    if (this.interrupted(record)) {
      await updateRecord(this.config, record, {
        stage: 'failed',
        error: 'meeting-minutes: processing was interrupted before completion',
      })
    }
    return await statusOf(this.config, record)
  }

  private interrupted(record: MeetingRecord): boolean {
    return record.stage !== 'complete' && record.stage !== 'failed' && !this.active.has(record.id)
  }

  /** Stop new work, cancel every active provider call, and await all owned processes. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort(new Error('meeting-minutes: plugin disposed'))
    await Promise.allSettled(this.admissions)
    await this.localWorker?.dispose()
    await this.tail
  }
}
