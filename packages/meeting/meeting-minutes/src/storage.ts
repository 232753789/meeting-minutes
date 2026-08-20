/** Private meeting-directory layout and atomic metadata publication. */

import type { Dirent } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ResolvedConfig } from './config.ts'
import type { MeetingId, MeetingRecord, MeetingStatus, TranscriptSegment } from './types.ts'

/** Durable meeting state filename. */
export const METADATA_FILENAME = 'metadata.json'
/** Transcoded MP4 recording filename, written only when the original is not already MP4. */
export const NORMALIZED_AUDIO_FILENAME = 'audio.mp4'
/** Structured transcript filename. */
export const TRANSCRIPT_JSON_FILENAME = 'transcript.json'
/** Plain-text transcript filename. */
export const TRANSCRIPT_TEXT_FILENAME = 'transcript.txt'
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
  const fullText = segments.map(segment => segment.text.trim()).filter(Boolean).join('\n')
  await Promise.all([
    writeFileAtomic(join(directory, json), `${JSON.stringify({ segments }, null, 2)}\n`, PRIVATE_FILE),
    writeFileAtomic(join(directory, text), `${fullText}\n`, PRIVATE_FILE),
  ])
  return { json, text, fullText }
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
    .map(segment => `[${timestamp(segment.startSeconds)}] ${segment.text.trim()}`)
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
