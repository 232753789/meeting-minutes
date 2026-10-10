/** Loopback same-origin HTTP routes for upload, retry, status, and artifact downloads. */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isLoopbackSameOriginRequest } from '@deepseek-ai/dsh-loopback-request'
import type { MeetingMinutesRuntime } from './runtime.ts'
import {
  isMeetingId,
  meetingDirectory,
  originalFilename,
  readRecord,
  sanitizeSourceFilename,
  TRANSCRIPT_TEXT_FILENAME,
  transcriptDownloadName,
  writeRecord,
} from './storage.ts'
import {
  MeetingId,
  type MeetingAccepted,
  type MeetingDeleted,
  type MeetingList,
  type MeetingRecord,
  type MeetingRetryMode,
} from './types.ts'

/** Route prefix owned by the meeting-minutes Host plugin. */
export const MEETING_API_PREFIX = '/meeting-minutes/api'
const MEETINGS_PATH = `${MEETING_API_PREFIX}/meetings`

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function parseInstant(req: IncomingMessage, name: string): string {
  const value = header(req, name)
  if (value === undefined || value === '') throw new HttpError(400, `missing ${name} header`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new HttpError(400, `invalid ${name} header`)
  return new Date(timestamp).toISOString()
}

function sourceFilename(req: IncomingMessage): string | undefined {
  const value = header(req, 'x-meeting-source-filename')
  if (value === undefined || value === '') return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new HttpError(400, 'invalid x-meeting-source-filename header')
  }
  return sanitizeSourceFilename(decoded)
}

/**
 * Resolve how much of a previous attempt the requested retry keeps.
 *
 * Omitting the parameter resumes, because a failed meeting is normally retried to get past what
 * failed, not to pay for the stages that already succeeded.
 */
function retryMode(url: URL): MeetingRetryMode {
  const value = url.searchParams.get('mode')
  if (value === null || value === 'resume') return 'resume'
  if (value === 'restart') return 'restart'
  throw new HttpError(400, 'mode must be resume or restart')
}

function newMeetingId(startedAt: string): MeetingId {
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('Z', '')
  return MeetingId(`meeting-${stamp}-${randomBytes(6).toString('hex')}`)
}

function contentLength(req: IncomingMessage): number | undefined {
  const value = header(req, 'content-length')
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

async function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  filename: string,
  contentType: string,
  downloadName?: string,
  fallbackDownloadName = 'meeting-minutes.md',
): Promise<void> {
  const info = await stat(filename)
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    ...(downloadName === undefined
      ? {}
      : { 'content-disposition': `attachment; filename="${fallbackDownloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}` }),
  }
  const range = header(req, 'range')
  if (range !== undefined) {
    const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(range)
    if (match === null) throw new HttpError(416, 'unsupported byte range')
    const start = Number(match[1])
    const end = match[2] === '' ? info.size - 1 : Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= info.size) {
      throw new HttpError(416, 'byte range is outside the file')
    }
    res.writeHead(206, {
      ...headers,
      'content-length': end - start + 1,
      'content-range': `bytes ${String(start)}-${String(end)}/${String(info.size)}`,
    })
    if (req.method === 'HEAD') res.end()
    else await pipeline(createReadStream(filename, { start, end }), res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': info.size })
  if (req.method === 'HEAD') res.end()
  else await pipeline(createReadStream(filename), res)
}

/** Tracks request and processing lifetimes so plugin disposal reaches quiescence. */
export class MeetingHttpController {
  private readonly handlers = new Set<Promise<void>>()
  private readonly requests = new Set<IncomingMessage>()
  private closed = false

  constructor(private readonly runtime: MeetingMinutesRuntime) {}

  /** WebServer route handler. */
  handle = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (this.closed) {
      res.writeHead(503)
      res.end()
      return Promise.resolve()
    }
    this.requests.add(req)
    const operation = this.dispatch(req, res).finally(() => {
      this.requests.delete(req)
      this.handlers.delete(operation)
    })
    this.handlers.add(operation)
    return operation
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackSameOriginRequest(req)) throw new HttpError(403, 'loopback same-origin access required')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname
      if (pathname === MEETINGS_PATH) {
        if (req.method === 'GET') {
          const meetings: MeetingList = { meetings: await this.runtime.list() }
          sendJson(res, 200, meetings)
          return
        }
        if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
        await this.upload(req, res)
        return
      }
      const match = new RegExp(
        `^${MEETINGS_PATH}/([^/]+)(?:/(audio|minutes|original|retry|transcript))?$`,
      ).exec(pathname)
      if (match === null || match[1] === undefined || !isMeetingId(match[1])) throw new HttpError(404, 'meeting not found')
      const id = match[1]
      const resource = match[2]
      if (resource === undefined) {
        if (req.method === 'DELETE') {
          const removal = await this.runtime.remove(id)
          if (removal.kind === 'missing') throw new HttpError(404, 'meeting not found')
          if (removal.kind === 'conflict') throw new HttpError(409, 'a meeting being processed cannot be deleted')
          const deleted: MeetingDeleted = { id }
          sendJson(res, 200, deleted)
          return
        }
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
        const status = await this.runtime.status(id)
        if (status === undefined) throw new HttpError(404, 'meeting not found')
        sendJson(res, 200, status)
        return
      }
      if (resource === 'retry') {
        if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
        const result = await this.runtime.retry(id, retryMode(url))
        if (result.kind === 'missing') throw new HttpError(404, 'meeting not found')
        if (result.kind === 'conflict') throw new HttpError(409, 'only an inactive complete or failed meeting can be reprocessed')
        const accepted: MeetingAccepted = { id, statusUrl: `${MEETINGS_PATH}/${id}` }
        sendJson(res, 202, accepted)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed')
      const record = await readRecord(this.runtime.config, id)
      if (record === undefined) throw new HttpError(404, 'meeting not found')
      if (resource === 'original') {
        await streamFile(
          req,
          res,
          join(meetingDirectory(this.runtime.config, id), record.originalFilename),
          record.originalMimeType,
          record.originalFilename,
          record.originalFilename,
        )
        return
      }
      if (resource === 'transcript') {
        if (record.transcriptText === undefined) throw new HttpError(409, 'the transcript is not ready')
        await streamFile(
          req,
          res,
          join(meetingDirectory(this.runtime.config, id), record.transcriptText),
          'text/plain; charset=utf-8',
          transcriptDownloadName(record),
          TRANSCRIPT_TEXT_FILENAME,
        )
        return
      }
      if (resource === 'audio') {
        if (record.normalizedAudio === undefined) throw new HttpError(409, 'normalized audio is not ready')
        await streamFile(
          req,
          res,
          join(meetingDirectory(this.runtime.config, id), record.normalizedAudio),
          'audio/mp4',
        )
        return
      }
      if (record.minutesFilename === undefined) throw new HttpError(409, 'meeting minutes are not ready')
      await streamFile(
        req,
        res,
        join(meetingDirectory(this.runtime.config, id), record.minutesFilename),
        'text/markdown; charset=utf-8',
        record.minutesFilename,
      )
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, status, { error: message })
      else res.destroy(error instanceof Error ? error : new Error(message))
    }
  }

  private async upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = parseInstant(req, 'x-meeting-started-at')
    const endedAt = parseInstant(req, 'x-meeting-ended-at')
    if (Date.parse(endedAt) < Date.parse(startedAt)) throw new HttpError(400, 'meeting end precedes start')
    const source = sourceFilename(req)
    const mimeType = header(req, 'content-type')?.trim() ?? ''
    if (!/^(audio|video)\//i.test(mimeType)) throw new HttpError(415, 'an audio or video media type is required')
    const declaredBytes = contentLength(req)
    if (declaredBytes !== undefined && declaredBytes > this.runtime.config.maxUploadBytes) {
      throw new HttpError(413, 'recording exceeds maxUploadBytes')
    }
    const id = newMeetingId(startedAt)
    await mkdir(this.runtime.config.storageRoot, { recursive: true, mode: 0o700 })
    const directory = meetingDirectory(this.runtime.config, id)
    await mkdir(directory, { mode: 0o700 })
    const filename = originalFilename(mimeType)
    const target = join(directory, filename)
    let bytes = 0
    try {
      const file = await open(target, 'wx', 0o600)
      try {
        for await (const value of req) {
          if (this.closed) throw new Error('meeting-minutes: plugin disposed during upload')
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
          bytes += chunk.length
          if (bytes > this.runtime.config.maxUploadBytes) throw new HttpError(413, 'recording exceeds maxUploadBytes')
          await file.write(chunk)
        }
      } finally {
        await file.close()
      }
      if (bytes === 0) throw new HttpError(400, 'recording body is empty')
      const now = new Date().toISOString()
      const record: MeetingRecord = {
        formatVersion: 1,
        id,
        stage: 'queued',
        createdAt: now,
        startedAt,
        endedAt,
        updatedAt: now,
        originalFilename: filename,
        originalMimeType: mimeType,
        originalBytes: bytes,
        ...(source === undefined ? {} : { sourceFilename: source }),
        completedChunks: 0,
      }
      await writeRecord(this.runtime.config, record)
      this.runtime.enqueue(record)
      const accepted: MeetingAccepted = { id, statusUrl: `${MEETINGS_PATH}/${id}` }
      sendJson(res, 202, accepted)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  /** Abort active request bodies and await every route handler. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const request of this.requests) request.destroy(new Error('meeting-minutes: plugin disposed'))
    await Promise.allSettled(this.handlers)
  }
}
