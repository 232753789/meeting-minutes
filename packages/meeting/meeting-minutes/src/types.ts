import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier for one persisted meeting. */
export type MeetingId = Branded<'MeetingId'>

/**
 * Construct a meeting id after the caller has validated or generated its wire value.
 * @param value - validated or internally generated wire value.
 * @returns the opaque meeting identifier.
 */
export function MeetingId(value: string): MeetingId {
  return value as MeetingId
}

/** Durable processing stage exposed to the browser. */
export type MeetingStage = 'queued' | 'normalizing' | 'transcribing' | 'summarizing' | 'complete' | 'failed'

/** One coarse, non-speaker-attributed ASR segment. */
export interface TranscriptSegment {
  /** Zero-based source chunk. */
  readonly index: number
  /** Coarse beginning of this chunk in the normalized recording. */
  readonly startSeconds: number
  /** ASR text for the complete chunk. */
  readonly text: string
}

/** One row of the browser-facing meeting history list. */
export interface MeetingListEntry {
  readonly id: MeetingId
  readonly stage: MeetingStage
  /** Final Markdown filename once summarized, otherwise the uploaded or recorded source filename. */
  readonly name: string
  /** Instant this meeting directory was created in the store. */
  readonly createdAt: string
}

/** Newest-first meeting history projection returned by the collection route. */
export interface MeetingList {
  readonly meetings: readonly MeetingListEntry[]
}

/** Browser-facing status for one accepted recording. */
export interface MeetingStatus {
  readonly id: MeetingId
  readonly stage: MeetingStage
  readonly startedAt: string
  readonly endedAt: string
  readonly updatedAt: string
  readonly completedChunks: number
  readonly totalChunks?: number
  readonly audioReady: boolean
  readonly topic?: string
  readonly transcript?: string
  readonly summaryMarkdown?: string
  readonly minutesFilename?: string
  readonly error?: string
}

/** Processing acknowledgement returned after an upload or retry is durably admitted. */
export interface MeetingAccepted {
  readonly id: MeetingId
  readonly statusUrl: string
}

/** Confirmation returned after one meeting directory is permanently removed. */
export interface MeetingDeleted {
  readonly id: MeetingId
}

/** Exact auxiliary LLM request persisted before dispatch. */
export interface SummaryRequestRecord {
  readonly index: number
  readonly createdAt: string
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly input: string
  readonly maxTokens: number
  output?: string
}

/** Private metadata stored inside one meeting directory. */
export interface MeetingRecord {
  readonly formatVersion: 1
  readonly id: MeetingId
  stage: MeetingStage
  readonly createdAt: string
  readonly startedAt: string
  readonly endedAt: string
  updatedAt: string
  readonly originalFilename: string
  readonly originalMimeType: string
  readonly originalBytes: number
  /** Display-only name of a browser-selected upload; never used to select a path. */
  readonly sourceFilename?: string
  completedChunks: number
  totalChunks?: number
  /** MP4 playback filename: the transcoded audio, or the original recording when it already is MP4. */
  normalizedAudio?: string
  transcriptJson?: string
  transcriptText?: string
  topic?: string
  summaryMarkdown?: string
  minutesFilename?: string
  error?: string
}
