import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { MeetingMinutesRuntime } from '../src/runtime.ts'
import { meetingDirectory, writeRecord, writeTranscript } from '../src/storage.ts'
import type { summarizeMeeting } from '../src/summary.ts'
import { MeetingId, type MeetingRecord, type SummaryRequestRecord } from '../src/types.ts'

const ctx = { logger: { warn: vi.fn() } } as unknown as Context

/** Stores one MP4 meeting whose playback file needs no transcoding. */
async function stored(prefix: string, extra: Partial<MeetingRecord> = {}): Promise<{
  config: ResolvedConfig
  record: MeetingRecord
  directory: string
}> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const config = resolveConfig({ asrMode: 'remote', storageRoot: root, timeZone: 'Asia/Shanghai' })
  const id = MeetingId('meeting-20260819T091500-0123456789ab')
  const directory = meetingDirectory(config, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'original.mp4'), 'preserved source')
  const record: MeetingRecord = {
    formatVersion: 1,
    id,
    stage: 'queued',
    createdAt: '2026-08-19T01:15:00.000Z',
    startedAt: '2026-08-19T01:15:00.000Z',
    endedAt: '2026-08-19T01:20:00.000Z',
    updatedAt: '2026-08-19T01:20:00.000Z',
    originalFilename: 'original.mp4',
    originalMimeType: 'audio/mp4',
    originalBytes: 16,
    completedChunks: 0,
    ...extra,
  }
  await writeRecord(config, record)
  return { config, record, directory }
}

/** Cuts three WAV chunks the way FFmpeg would, without transcoding an MP4 original. */
function chunker(directory: string, count: number): () => Promise<{
  audioFilename: string
  chunkDirectory: string
  chunks: string[]
}> {
  return async () => {
    const chunkDirectory = join(directory, '.wav-chunks')
    await mkdir(chunkDirectory, { recursive: true })
    const chunks = Array.from({ length: count }, (_value, index) =>
      join(chunkDirectory, `chunk-0000${String(index)}.wav`))
    await Promise.all(chunks.map(path => writeFile(path, 'wav')))
    return { audioFilename: 'original.mp4', chunkDirectory, chunks }
  }
}

const summaryFor = (topic: string): typeof summarizeMeeting => () =>
  Promise.resolve({ topic, summaryMarkdown: `### 决策\n\n${topic}。` })

describe('resuming a failed meeting', () => {
  it('transcribes only the chunks the failed attempt never reached', async () => {
    const { config, record, directory } = await stored('meeting-resume-asr-')
    let failSecondChunk = true
    const remoteAsr = vi.fn((_config: ResolvedConfig, path: string) => {
      if (path.endsWith('chunk-00001.wav') && failSecondChunk) {
        failSecondChunk = false
        return Promise.reject(new Error('ASR unavailable'))
      }
      return Promise.resolve(`第 ${path.slice(-6, -4)} 段。`)
    })
    const normalize = vi.fn(chunker(directory, 3))
    const runtime = new MeetingMinutesRuntime(ctx, config, {
      normalize,
      remoteAsr,
      summarize: summaryFor('续跑会议'),
    })
    runtime.enqueue(record)
    await vi.waitFor(async () => { expect((await runtime.status(record.id))?.stage).toBe('failed') })

    const failed = await runtime.status(record.id)
    expect(failed?.error).toContain('ASR unavailable')
    expect(failed?.completedChunks).toBe(1)
    expect(failed?.resumeFrom).toBe('transcribing')

    await expect(runtime.retry(record.id, 'resume')).resolves.toEqual({ kind: 'accepted' })
    await vi.waitFor(async () => { expect((await runtime.status(record.id))?.stage).toBe('complete') })

    expect(remoteAsr.mock.calls.map(call => call[1].slice(-9))).toEqual([
      'chunk-00000.wav'.slice(-9),
      'chunk-00001.wav'.slice(-9),
      'chunk-00001.wav'.slice(-9),
      'chunk-00002.wav'.slice(-9),
    ])
    const status = await runtime.status(record.id)
    expect(status?.transcript).toBe('第 00 段。\n第 01 段。\n第 02 段。\n')
    expect(status?.resumeFrom).toBeUndefined()
    expect(normalize).toHaveBeenCalledTimes(2)
    await expect(readFile(join(directory, 'transcript-progress.json'), 'utf8')).rejects.toThrow()
    await runtime.dispose()
  })

  it('skips normalization and ASR when the transcript is already published', async () => {
    const { config, record, directory } = await stored('meeting-resume-summary-')
    const transcript = await writeTranscript(config, record.id, [
      { index: 0, startSeconds: 0, text: '第一段。' },
      { index: 1, startSeconds: 300, text: '第二段。' },
    ])
    record.normalizedAudio = 'original.mp4'
    record.transcriptJson = transcript.json
    record.transcriptText = transcript.text
    record.totalChunks = 2
    record.completedChunks = 2
    record.stage = 'failed'
    record.error = 'meeting-minutes: summary route unavailable'
    await writeRecord(config, record)
    const persisted: SummaryRequestRecord = {
      index: 0,
      createdAt: '2026-08-19T01:21:00.000Z',
      provider: 'fixture',
      model: 'fixture-model',
      system: 'partial',
      input: '第一段。',
      maxTokens: 4_096,
      output: '第一段摘要。',
    }
    await writeFile(
      join(directory, 'summary-requests.json'),
      `${JSON.stringify({ requests: [persisted] }, null, 2)}\n`,
    )
    const normalize = vi.fn(chunker(directory, 2))
    const remoteAsr = vi.fn(() => Promise.resolve('未使用'))
    const summarize = vi.fn(summaryFor('只重跑摘要'))
    const runtime = new MeetingMinutesRuntime(ctx, config, { normalize, remoteAsr, summarize })

    expect((await runtime.status(record.id))?.resumeFrom).toBe('summarizing')
    await expect(runtime.retry(record.id, 'resume')).resolves.toEqual({ kind: 'accepted' })
    await vi.waitFor(async () => { expect((await runtime.status(record.id))?.stage).toBe('complete') })

    expect(normalize).not.toHaveBeenCalled()
    expect(remoteAsr).not.toHaveBeenCalled()
    expect(summarize.mock.calls[0]?.[3]).toBe('第一段。\n第二段。')
    expect(summarize.mock.calls[0]?.[5]).toEqual([persisted])
    const status = await runtime.status(record.id)
    expect(status?.transcript).toBe('第一段。\n第二段。\n')
    expect(status?.minutesFilename).toBe('2026-08-19_09-15_只重跑摘要_5m.md')
    await runtime.dispose()
  })

  it('discards every reusable artifact when a full reprocess is requested', async () => {
    const { config, record, directory } = await stored('meeting-restart-')
    const transcript = await writeTranscript(config, record.id, [
      { index: 0, startSeconds: 0, text: '旧的转写。' },
    ])
    record.normalizedAudio = 'original.mp4'
    record.transcriptJson = transcript.json
    record.transcriptText = transcript.text
    record.totalChunks = 1
    record.completedChunks = 1
    record.stage = 'failed'
    await writeRecord(config, record)
    await writeFile(
      join(directory, 'summary-requests.json'),
      `${JSON.stringify({ requests: [{ index: 0, system: 'partial', input: '旧的转写。', output: '旧摘要。' }] }, null, 2)}\n`,
    )
    const normalize = vi.fn(chunker(directory, 1))
    const remoteAsr = vi.fn(() => Promise.resolve('新的转写。'))
    const summarize = vi.fn(summaryFor('完整重跑'))
    const runtime = new MeetingMinutesRuntime(ctx, config, { normalize, remoteAsr, summarize })

    await expect(runtime.retry(record.id, 'restart')).resolves.toEqual({ kind: 'accepted' })
    await vi.waitFor(async () => { expect((await runtime.status(record.id))?.stage).toBe('complete') })

    expect(normalize).toHaveBeenCalledTimes(1)
    expect(remoteAsr).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0]?.[5]).toEqual([])
    expect((await runtime.status(record.id))?.transcript).toBe('新的转写。\n')
    await runtime.dispose()
  })

  it('resumes a record a Host restart left mid-transcription', async () => {
    const { config, record, directory } = await stored('meeting-resume-restart-', {
      stage: 'transcribing',
      normalizedAudio: 'original.mp4',
      totalChunks: 2,
      completedChunks: 1,
    })
    await writeFile(
      join(directory, 'transcript-progress.json'),
      `${JSON.stringify({ chunkSeconds: config.asrChunkSeconds, segments: [{ index: 0, startSeconds: 0, text: '重启前完成的一段。' }] }, null, 2)}\n`,
    )
    const remoteAsr = vi.fn(() => Promise.resolve('重启后完成的一段。'))
    const runtime = new MeetingMinutesRuntime(ctx, config, {
      normalize: vi.fn(chunker(directory, 2)),
      remoteAsr,
      summarize: summaryFor('跨重启续跑'),
    })

    const interrupted = await runtime.status(record.id)
    expect(interrupted?.stage).toBe('failed')
    expect(interrupted?.resumeFrom).toBe('transcribing')

    await expect(runtime.retry(record.id, 'resume')).resolves.toEqual({ kind: 'accepted' })
    await vi.waitFor(async () => { expect((await runtime.status(record.id))?.stage).toBe('complete') })

    expect(remoteAsr).toHaveBeenCalledTimes(1)
    expect((await runtime.status(record.id))?.transcript)
      .toBe('重启前完成的一段。\n重启后完成的一段。\n')
    await runtime.dispose()
  })
})
