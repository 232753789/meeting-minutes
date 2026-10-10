/** Private meeting-directory layout and atomic metadata publication. */

import type { Dirent } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ResolvedConfig } from './config.ts'
import type {
  CompletedSummaryRequest,
  MeetingId,
  MeetingRecord,
  MeetingStage,
  MeetingStatus,
  TranscriptProgress,
  TranscriptSegment,
} from './types.ts'

/** Durable meeting state filename. */
export const METADATA_FILENAME = 'metadata.json'
/** Transcoded MP4 recording filename, written only when the original is not already MP4. */
export const NORMALIZED_AUDIO_FILENAME = 'audio.mp4'
/** Structured transcript filename. */
export const TRANSCRIPT_JSON_FILENAME = 'transcript.json'
/** Plain-text transcript filename. */
export const TRANSCRIPT_TEXT_FILENAME = 'transcript.txt'
/** Completed-chunk transcription progress filename, removed once the transcript is complete. */
export const TRANSCRIPT_PROGRESS_FILENAME = 'transcript-progress.json'
/** Durable summary request audit filename. */
export const SUMMARY_REQUESTS_FILENAME = 'summary-requests.json'

const PRIVATE_FILE = { mode: 0o600, dirMode: 0o700 } as const
const MEETING_ID_PATTERN = /^meeting-[0-9]{8}T[0-9]{6}-[0-9a-f]{12}$/

/**
 * Reject a wire id before it can select a filesystem path.
 *
 * @param value Candidate meeting id.
 * @returns Whether the value is a valid meeting id.
 */
export function isMeetingId(value: string): value is MeetingId {
  return MEETING_ID_PATTERN.test(value)
}

/**
 * Resolve the private directory for a generated or validated meeting id.
 *
 * @param config Resolved plugin configuration.
 * @param id Generated or validated meeting id.
 * @returns Absolute meeting directory.
 */
export function meetingDirectory(config: ResolvedConfig, id: MeetingId): string {
  return join(config.storageRoot, id)
}

/**
 * Atomically publish the complete metadata record with owner-only permissions.
 *
 * @param config Resolved plugin configuration.
 * @param record Complete meeting record.
 */
export async function writeRecord(config: ResolvedConfig, record: MeetingRecord): Promise<void> {
  await writeFileAtomic(
    join(meetingDirectory(config, record.id), METADATA_FILENAME),
    `${JSON.stringify(record, null, 2)}\n`,
    PRIVATE_FILE,
  )
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read and minimally validate a durable record selected by a validated id.
 *
 * @param config Resolved plugin configuration.
 * @param id Validated meeting id.
 * @returns Meeting record, or `undefined` when it does not exist.
 */
export async function readRecord(config: ResolvedConfig, id: MeetingId): Promise<MeetingRecord | undefined> {
  let text: string
  try {
    text = await readFile(join(meetingDirectory(config, id), METADATA_FILENAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  const value = objectRecord(parsed)
  if (value === undefined || value.formatVersion !== 1 || value.id !== id || typeof value.stage !== 'string') {
    throw new Error(`meeting-minutes: corrupt metadata for ${id}`)
  }
  return parsed as MeetingRecord
}

function listedRecord(config: ResolvedConfig, id: MeetingId): Promise<MeetingRecord | undefined> {
  return readRecord(config, id).catch(() => {
    // One corrupt or unreadable metadata.json must not hide every other meeting from the history list.
    return undefined
  })
}

function newestFirst(left: MeetingRecord, right: MeetingRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.id < right.id ? 1 : -1
}

/**
 * Read every stored meeting and keep the newest `listMaxMeetings` records.
 *
 * All meeting directories are read because ids order by recording start, which an upload of an
 * older file does not follow.
 *
 * @param config Resolved plugin configuration.
 * @returns Records ordered by creation instant, newest first.
 */
export async function listMeetings(config: ResolvedConfig): Promise<MeetingRecord[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(config.storageRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const ids = entries.flatMap(entry => entry.isDirectory() && isMeetingId(entry.name) ? [entry.name] : [])
  const records: MeetingRecord[] = []
  for (const record of await Promise.all(ids.map(id => listedRecord(config, id)))) {
    if (record !== undefined) records.push(record)
  }
  return records.sort(newestFirst).slice(0, config.listMaxMeetings)
}

/**
 * Choose the history-list label required for one meeting.
 *
 * @param record Complete private meeting record.
 * @returns Final Markdown filename once summarized, otherwise the source recording filename.
 */
export function meetingDisplayName(record: MeetingRecord): string {
  return record.minutesFilename ?? record.sourceFilename ?? record.originalFilename
}

/**
 * Reduce a browser-supplied upload name to a display-only label.
 *
 * The result is persisted in metadata and rendered in the history list; it never selects a path.
 *
 * @param value Percent-decoded browser filename.
 * @returns Display label, or `undefined` when nothing printable remains.
 */
export function sanitizeSourceFilename(value: string): string | undefined {
  const base = value.split(/[/\\]/).pop() ?? ''
  const cleaned = base.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned === '' ? undefined : Array.from(cleaned).slice(0, 120).join('')
}

/**
 * Replace mutable record fields and publish one stage transition.
 *
 * @param config Resolved plugin configuration.
 * @param record Mutable in-memory meeting record.
 * @param update Fields to replace before publication.
 */
export async function updateRecord(
  config: ResolvedConfig,
  record: MeetingRecord,
  update: Partial<Omit<MeetingRecord, 'formatVersion' | 'id' | 'createdAt' | 'startedAt' | 'endedAt'>>,
): Promise<void> {
  Object.assign(record, update, { updatedAt: new Date().toISOString() })
  await writeRecord(config, record)
}

/**
 * Concatenate the segment texts that make up the summarizer's input.
 *
 * @param segments Ordered ASR segments.
 * @returns Transcript text without timestamps or empty segments.
 */
export function transcriptFullText(segments: readonly TranscriptSegment[]): string {
  return segments
    .map(segment => `${speakerLabel(segment)}${segment.text.trim()}`.trim())
    .filter(Boolean)
    .join('\n')
}

function speakerLabel(segment: TranscriptSegment): string {
  return segment.speaker === undefined ? '' : `[说话人 ${segment.speaker.slice('speaker-'.length)}] `
}

/**
 * Write full transcript artifacts after every ASR chunk has completed.
 *
 * @param config Resolved plugin configuration.
 * @param id Meeting id that owns the transcript.
 * @param segments Ordered ASR segments.
 * @returns Artifact filenames and concatenated transcript text.
 */
export async function writeTranscript(
  config: ResolvedConfig,
  id: MeetingId,
  segments: readonly TranscriptSegment[],
): Promise<{ json: string; text: string; fullText: string }> {
  const directory = meetingDirectory(config, id)
  const json = TRANSCRIPT_JSON_FILENAME
  const text = TRANSCRIPT_TEXT_FILENAME
  const fullText = transcriptFullText(segments)
  await Promise.all([
    writeFileAtomic(join(directory, json), `${JSON.stringify({ segments }, null, 2)}\n`, PRIVATE_FILE),
    writeFileAtomic(join(directory, text), `${fullText}\n`, PRIVATE_FILE),
  ])
  return { json, text, fullText }
}

/**
 * Publish the ASR chunks completed so far so the next attempt can start after them.
 *
 * Written before the record's `completedChunks`, so a crash between the two writes leaves progress
 * ahead of the record rather than transcript text the next attempt would silently drop.
 *
 * @param config Resolved plugin configuration.
 * @param id Meeting id that owns the transcription.
 * @param segments Completed segments in chunk order.
 * @param layout Whether the progress uses fixed chunks or diarized speaker intervals.
 */
export function writeTranscriptProgress(
  config: ResolvedConfig,
  id: MeetingId,
  segments: readonly TranscriptSegment[],
  layout: 'fixed' | 'speaker' = 'fixed',
): Promise<void> {
  const progress: TranscriptProgress = { chunkSeconds: config.asrChunkSeconds, layout, segments }
  return writeMeetingText(config, id, TRANSCRIPT_PROGRESS_FILENAME, `${JSON.stringify(progress, null, 2)}\n`)
}

/**
 * Read one optional JSON sidecar as an object.
 *
 * Absent, half-written, and not-an-object all mean the same thing to the callers: the work the file
 * would have saved is done again. A file that exists but cannot be read is not that case.
 *
 * @param path Absolute artifact path.
 * @returns Parsed object, or `undefined` when the file is missing or unusable.
 */
async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return objectRecord(JSON.parse(text))
  } catch {
    // A half-written hint file costs the work it would have saved; the recording is still stored.
    return undefined
  }
}

function validSegments(
  value: unknown,
  chunkSeconds: number,
  totalChunks: number,
  layout: 'fixed' | 'speaker' | 'any' = 'fixed',
): TranscriptSegment[] | undefined {
  if (!Array.isArray(value) || value.length > totalChunks) return undefined
  const segments: TranscriptSegment[] = []
  for (const [index, entry] of value.entries()) {
    const segment = objectRecord(entry)
    if (segment === undefined) return undefined
    if (segment.index !== index || typeof segment.startSeconds !== 'number' || !Number.isFinite(segment.startSeconds)) return undefined
    if (layout === 'fixed' && segment.startSeconds !== index * chunkSeconds) return undefined
    if (segment.endSeconds !== undefined
      && (typeof segment.endSeconds !== 'number' || !Number.isFinite(segment.endSeconds) || segment.endSeconds <= segment.startSeconds)) {
      return undefined
    }
    if (segment.speaker !== undefined
      && (typeof segment.speaker !== 'string' || !/^speaker-[0-9]+$/u.test(segment.speaker))) return undefined
    if (typeof segment.text !== 'string') return undefined
    segments.push(segment as unknown as TranscriptSegment)
  }
  return segments
}

/**
 * Read the completed chunks of an interrupted transcription.
 *
 * Progress produced under a different chunk duration or a different chunk count no longer aligns
 * with the chunks this attempt transcribes, so it is discarded instead of shifting the transcript.
 *
 * @param config Resolved plugin configuration.
 * @param id Validated meeting id.
 * @param totalChunks Chunks this attempt will transcribe.
 * @param layout Whether the progress uses fixed chunks or diarized speaker intervals.
 * @returns Reusable leading segments, empty when none apply.
 */
export async function readTranscriptProgress(
  config: ResolvedConfig,
  id: MeetingId,
  totalChunks: number,
  layout: 'fixed' | 'speaker' = 'fixed',
): Promise<TranscriptSegment[]> {
  const value = await readJsonObject(join(meetingDirectory(config, id), TRANSCRIPT_PROGRESS_FILENAME))
  if (value === undefined || value.chunkSeconds !== config.asrChunkSeconds) return []
  if (layout === 'speaker' && value.layout !== 'speaker') return []
  if (layout === 'fixed' && value.layout !== undefined && value.layout !== 'fixed') return []
  return validSegments(value.segments, config.asrChunkSeconds, totalChunks, layout) ?? []
}

/**
 * Delete the progress file a completed transcript replaces.
 *
 * @param config Resolved plugin configuration.
 * @param id Validated meeting id.
 */
export function removeTranscriptProgress(config: ResolvedConfig, id: MeetingId): Promise<void> {
  return rm(join(meetingDirectory(config, id), TRANSCRIPT_PROGRESS_FILENAME), { force: true })
}

/**
 * Read the published transcript of a meeting whose transcription already completed.
 *
 * The playback file is required alongside it because the Markdown artifact links to it, and both
 * are published in the same record update.
 *
 * @param config Resolved plugin configuration.
 * @param record Complete private meeting record.
 * @returns Artifact filenames and ordered segments, or `undefined` when this meeting must be
 * transcribed again.
 */
export async function readCompletedTranscript(
  config: ResolvedConfig,
  record: MeetingRecord,
): Promise<{ audioFilename: string; json: string; text: string; segments: TranscriptSegment[] } | undefined> {
  const { normalizedAudio, transcriptJson, transcriptText } = record
  if (normalizedAudio === undefined || transcriptJson === undefined || transcriptText === undefined) {
    return undefined
  }
  const value = await readJsonObject(join(meetingDirectory(config, record.id), transcriptJson))
  if (value === undefined || !Array.isArray(value.segments)) return undefined
  const segments = validSegments(value.segments, config.asrChunkSeconds, value.segments.length, 'any')
  if (segments === undefined || segments.length === 0) return undefined
  return { audioFilename: normalizedAudio, json: transcriptJson, text: transcriptText, segments }
}

/**
 * Read the leading run of summary requests a previous attempt completed.
 *
 * The run stops at the first request without an output — where the previous attempt stopped —
 * because positions after it no longer line up with the requests this attempt makes.
 *
 * @param config Resolved plugin configuration.
 * @param id Validated meeting id.
 * @returns Completed requests in dispatch order, empty when the audit is absent or unreadable.
 */
export async function readSummaryRequests(
  config: ResolvedConfig,
  id: MeetingId,
): Promise<CompletedSummaryRequest[]> {
  const value = await readJsonObject(join(meetingDirectory(config, id), SUMMARY_REQUESTS_FILENAME))
  if (value === undefined || !Array.isArray(value.requests)) return []
  const completed: CompletedSummaryRequest[] = []
  for (const entry of value.requests) {
    const request = objectRecord(entry)
    if (request === undefined || typeof request.output !== 'string') break
    completed.push(request as unknown as CompletedSummaryRequest)
  }
  return completed
}

/**
 * Delete the derived progress and audit files a full reprocess must not reuse.
 *
 * @param config Resolved plugin configuration.
 * @param id Validated meeting id.
 */
export async function removeResumableProgress(config: ResolvedConfig, id: MeetingId): Promise<void> {
  const directory = meetingDirectory(config, id)
  await Promise.all([
    rm(join(directory, TRANSCRIPT_PROGRESS_FILENAME), { force: true }),
    rm(join(directory, SUMMARY_REQUESTS_FILENAME), { force: true }),
  ])
}

/**
 * Report the stage a `resume` retry would start this failed meeting at.
 *
 * Only a failed meeting has a stage to resume from; a complete one is reprocessed in full or not
 * at all. The artifacts named here are the ones {@link readCompletedSegments} and
 * {@link readTranscriptProgress} let the next attempt reuse.
 *
 * @param record Complete private meeting record.
 * @returns Stage the reusable artifacts allow, or `undefined` when the attempt starts over.
 */
export function resumeStage(record: MeetingRecord): MeetingStage | undefined {
  if (record.stage !== 'failed') return undefined
  if (record.transcriptJson !== undefined && record.normalizedAudio !== undefined) return 'summarizing'
  if (record.normalizedAudio !== undefined || record.completedChunks > 0) return 'transcribing'
  return undefined
}

/**
 * Build the browser-safe projection of private metadata.
 *
 * @param config Resolved plugin configuration.
 * @param record Complete private meeting record.
 * @returns Status fields and any published transcript.
 */
export async function statusOf(config: ResolvedConfig, record: MeetingRecord): Promise<MeetingStatus> {
  let transcript: string | undefined
  if (record.transcriptText !== undefined) {
    transcript = await readFile(join(meetingDirectory(config, record.id), record.transcriptText), 'utf8')
  }
  const resume = resumeStage(record)
  return {
    id: record.id,
    stage: record.stage,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    updatedAt: record.updatedAt,
    completedChunks: record.completedChunks,
    ...(record.totalChunks === undefined ? {} : { totalChunks: record.totalChunks }),
    audioReady: record.normalizedAudio !== undefined,
    ...(record.topic === undefined ? {} : { topic: record.topic }),
    ...(transcript === undefined ? {} : { transcript }),
    ...(record.summaryMarkdown === undefined ? {} : { summaryMarkdown: record.summaryMarkdown }),
    ...(record.minutesFilename === undefined ? {} : { minutesFilename: record.minutesFilename }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(resume === undefined ? {} : { resumeFrom: resume }),
  }
}

/**
 * Delete one meeting directory and every artifact it owns.
 *
 * The caller owns the durable-stage and activity checks; this removal is not recoverable.
 *
 * @param config Resolved plugin configuration.
 * @param id Validated meeting id.
 */
export function removeMeeting(config: ResolvedConfig, id: MeetingId): Promise<void> {
  return rm(meetingDirectory(config, id), { recursive: true, force: true })
}

/**
 * Choose the download filename for the plain-text transcript.
 *
 * @param record Complete private meeting record.
 * @returns Markdown basename carrying a `.txt` extension, or the stored transcript filename.
 */
export function transcriptDownloadName(record: MeetingRecord): string {
  return record.minutesFilename === undefined
    ? TRANSCRIPT_TEXT_FILENAME
    : `${basename(record.minutesFilename, '.md')}.txt`
}

/**
 * Derive a safe original filename from a browser-provided media type.
 *
 * @param mimeType Browser-provided media type.
 * @returns Fixed filename for the recognized media type.
 */
export function originalFilename(mimeType: string): string {
  const essence = mimeType.split(';', 1)[0]?.trim().toLowerCase()
  switch (essence) {
    case 'audio/mp4':
    case 'video/mp4':
      return 'original.mp4'
    case 'audio/webm':
    case 'video/webm':
      return 'original.webm'
    case 'audio/ogg':
      return 'original.ogg'
    case 'audio/mpeg':
      return 'original.mp3'
    case 'audio/wav':
    case 'audio/x-wav':
      return 'original.wav'
    default:
      return 'original.audio'
  }
}

function timeParts(instant: string, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]))
}

/**
 * Convert a model topic into one portable filename component.
 *
 * @param topic Model-generated meeting topic.
 * @returns Portable, length-limited filename component.
 */
export function sanitizeTopic(topic: string): string {
  const cleaned = topic.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  return Array.from(cleaned || '未命名会议').slice(0, 40).join('')
}

/**
 * Round one meeting's recorded length up to whole minutes.
 *
 * @param record Meeting timestamps.
 * @returns Whole minutes, never below one.
 */
export function durationMinutes(record: MeetingRecord): number {
  const milliseconds = Date.parse(record.endedAt) - Date.parse(record.startedAt)
  return Math.max(1, Math.ceil(milliseconds / 60_000))
}

/**
 * Build the required date/start/topic/duration Markdown basename.
 *
 * @param record Meeting timestamps.
 * @param topic Model-generated meeting topic.
 * @param timeZone IANA timezone used for filename timestamps.
 * @returns Markdown filename without a directory.
 */
export function minutesBasename(record: MeetingRecord, topic: string, timeZone: string): string {
  const start = timeParts(record.startedAt, timeZone)
  return `${start.year}-${start.month}-${start.day}_${start.hour}-${start.minute}_${sanitizeTopic(topic)}_${String(durationMinutes(record))}m.md`
}

/**
 * Choose the required filename, adding a short id only on collision.
 *
 * @param config Resolved plugin configuration.
 * @param record Meeting timestamps and id.
 * @param topic Model-generated meeting topic.
 * @returns Available Markdown filename within the meeting directory.
 */
export async function availableMinutesFilename(
  config: ResolvedConfig,
  record: MeetingRecord,
  topic: string,
): Promise<string> {
  const candidate = minutesBasename(record, topic, config.timeZone)
  try {
    await stat(join(meetingDirectory(config, record.id), candidate))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
    throw error
  }
  const suffix = String(record.id).slice(-6)
  return `${basename(candidate, '.md')}-${suffix}.md`
}

/**
 * Render a complete Markdown artifact with recording links, summary, and full transcript.
 *
 * @param record Meeting metadata and recording filenames.
 * @param audioFilename MP4 playback filename, which is the original recording when it already is MP4.
 * @param topic Model-generated meeting topic.
 * @param summaryMarkdown Model-generated meeting summary.
 * @param segments Ordered ASR segments.
 * @returns Complete downloadable Markdown document.
 */
export function renderMinutes(
  record: MeetingRecord,
  audioFilename: string,
  topic: string,
  summaryMarkdown: string,
  segments: readonly TranscriptSegment[],
): string {
  const timestamp = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const remainder = Math.floor(seconds % 60)
    return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':')
  }
  const transcript = segments
    .map(segment => `[${timestamp(segment.startSeconds)}] ${speakerLabel(segment)}${segment.text.trim()}`)
    .join('\n\n')
  return [
    `# ${topic}`,
    '',
    `- 会议 ID：${record.id}`,
    `- 开始时间：${record.startedAt}`,
    `- 结束时间：${record.endedAt}`,
    `- 原始录音：[${record.originalFilename}](./${record.originalFilename})`,
    ...(audioFilename === record.originalFilename
      ? []
      : [`- MP4 音频：[${audioFilename}](./${audioFilename})`]),
    '',
    '## 会议纪要',
    '',
    summaryMarkdown.trim(),
    '',
    '## 全量转写',
    '',
    transcript,
    '',
  ].join('\n')
}

/**
 * Atomically write an arbitrary private text artifact in one meeting directory.
 *
 * @param config Resolved plugin configuration.
 * @param id Meeting id that owns the artifact.
 * @param filename Artifact filename.
 * @param text Complete artifact contents.
 */
export function writeMeetingText(
  config: ResolvedConfig,
  id: MeetingId,
  filename: string,
  text: string,
): Promise<void> {
  return writeFileAtomic(join(meetingDirectory(config, id), filename), text, PRIVATE_FILE)
}
