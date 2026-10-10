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

/**
 * How much of a previous attempt another processing attempt keeps.
 *
 * `resume` restarts at the stage the previous attempt failed in, reusing the transcoded MP4, every
 * completed ASR chunk, and every completed summary request. `restart` discards all of them and
 * reruns the complete chain from the preserved original recording.
 */
export type MeetingRetryMode = 'resume' | 'restart'

/** Speaker label assigned by the configured diarization provider. */
export type SpeakerId = `speaker-${number}`

/** One ASR segment with optional speaker attribution and time range. */
export interface TranscriptSegment {
  /** Zero-based source chunk. */
  readonly index: number
  /** Beginning of this segment in the normalized recording. */
  readonly startSeconds: number
  /** End of this segment in the normalized recording, when available. */
  readonly endSeconds?: number
  /** Speaker assigned by diarization, when enabled. */
  readonly speaker?: SpeakerId
  /** ASR text for the complete segment. */
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
  /** Stage a `resume` retry would start at; absent when nothing of this meeting can be reused. */
  readonly resumeFrom?: MeetingStage
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

/** Completed ASR chunks of an unfinished transcription, persisted for the next attempt. */
export interface TranscriptProgress {
  /** Chunk duration the segments were produced with; a changed value invalidates them. */
  readonly chunkSeconds: number
  /** Whether segments use fixed time chunks or diarized speaker intervals. */
  readonly layout?: 'fixed' | 'speaker'
  /** Completed segments, indexed from zero without gaps. */
  readonly segments: readonly TranscriptSegment[]
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

/**
 * A persisted summary request whose output was recorded.
 *
 * The audit is written in dispatch order and an output is stored as soon as one arrives, so the
 * requests carrying an output form the leading run a later attempt can replay.
 */
export interface CompletedSummaryRequest extends SummaryRequestRecord {
  readonly output: string
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
