import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { MeetingMinutesRuntime } from '../src/runtime.ts'
import { meetingDirectory, writeRecord } from '../src/storage.ts'
import { MeetingId, type MeetingRecord } from '../src/types.ts'

describe('meeting processing runtime', () => {
  it('serially materializes transcript, summary, and the required Markdown artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-runtime-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root, timeZone: 'Asia/Shanghai' })
    const id = MeetingId('meeting-20260819T091500-012345abcdef')
    const directory = meetingDirectory(config, id)
    await mkdir(directory)
    await writeFile(join(directory, 'original.webm'), 'source')
    const record: MeetingRecord = {
      formatVersion: 1,
      id,
      stage: 'queued',
      createdAt: '2026-08-19T01:15:00.000Z',
      startedAt: '2026-08-19T01:15:00.000Z',
      endedAt: '2026-08-19T01:20:00.000Z',
      updatedAt: '2026-08-19T01:20:00.000Z',
      originalFilename: 'original.webm',
      originalMimeType: 'audio/webm',
      originalBytes: 6,
      completedChunks: 0,
    }
    await writeRecord(config, record)
    const logger = { warn: vi.fn() }
    const ctx = { logger } as unknown as Context
    const runtime = new MeetingMinutesRuntime(ctx, config, {
      normalize: async () => {
        const chunks = join(directory, '.wav-chunks')
        await mkdir(chunks)
        const paths = [join(chunks, 'chunk-00000.wav'), join(chunks, 'chunk-00001.wav')]
        await Promise.all(paths.map((path, index) => writeFile(path, `chunk ${String(index)}`)))
        await writeFile(join(directory, 'audio.mp4'), 'mp4')
        return {
          audioFilename: 'audio.mp4',
          chunkDirectory: chunks,
          chunks: paths.map((path, index) => ({
            path,
            startSeconds: index * config.asrChunkSeconds,
            endSeconds: (index + 1) * config.asrChunkSeconds,
          })),
        }
      },
      remoteAsr: async (_config, path) => path.endsWith('00000.wav') ? '第一段。' : '第二段。',
      summarize: async () => ({ topic: '项目周会', summaryMarkdown: '### 决策\n\n继续推进。' }),
    })
    runtime.enqueue(record)

    let status = await runtime.status(id)
    for (let attempt = 0; attempt < 50 && status?.stage !== 'complete'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = await runtime.status(id)
    }
    expect(status?.stage).toBe('complete')
    expect(status?.transcript).toBe('第一段。\n第二段。\n')
    expect(status?.minutesFilename).toBe('2026-08-19_09-15_项目周会_5m.md')
    const markdown = await readFile(join(directory, status!.minutesFilename!), 'utf8')
    expect(markdown).toContain('继续推进。')
    expect(markdown).toContain('[00:05:00] 第二段。')
    expect(logger.warn).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('admits one retry, reuses the original upload, and awaits retried work during disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-retry-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root, timeZone: 'Asia/Shanghai' })
    const id = MeetingId('meeting-20260819T091500-abcdef012345')
    const directory = meetingDirectory(config, id)
    await mkdir(directory)
    await writeFile(join(directory, 'original.webm'), 'preserved source')
    const record: MeetingRecord = {
      formatVersion: 1,
      id,
      stage: 'queued',
      createdAt: '2026-08-19T01:15:00.000Z',
      startedAt: '2026-08-19T01:15:00.000Z',
      endedAt: '2026-08-19T01:20:00.000Z',
      updatedAt: '2026-08-19T01:20:00.000Z',
      originalFilename: 'original.webm',
      originalMimeType: 'audio/webm',
      originalBytes: 16,
      completedChunks: 0,
    }
    await writeRecord(config, record)
    let releaseRetry!: (text: string) => void
    const retryAsr = new Promise<string>((resolve) => { releaseRetry = resolve })
    const remoteAsr = vi.fn()
      .mockRejectedValueOnce(new Error('ASR unavailable'))
      .mockImplementationOnce(async () => await retryAsr)
    const normalize = vi.fn(async () => {
      const chunks = join(directory, '.wav-chunks')
      await mkdir(chunks)
      const chunk = join(chunks, 'chunk-00000.wav')
      await writeFile(chunk, 'chunk')
      await writeFile(join(directory, 'audio.mp4'), 'mp4')
      return { audioFilename: 'audio.mp4', chunkDirectory: chunks, chunks: [{ path: chunk, startSeconds: 0, endSeconds: config.asrChunkSeconds }] }
    })
    const runtime = new MeetingMinutesRuntime({ logger: { warn: vi.fn() } } as unknown as Context, config, {
      normalize,
      remoteAsr,
      summarize: async () => ({ topic: '重试会议', summaryMarkdown: '### 结论\n\n重试完成。' }),
    })
    runtime.enqueue(record)

    let status = await runtime.status(id)
    for (let attempt = 0; attempt < 50 && status?.stage !== 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = await runtime.status(id)
    }
    expect(status?.stage).toBe('failed')
    expect(status?.error).toContain('ASR unavailable')

    const [firstRetry, secondRetry] = await Promise.all([
      runtime.retry(id, 'resume'),
      runtime.retry(id, 'resume'),
    ])
    expect([firstRetry.kind, secondRetry.kind].sort()).toEqual(['accepted', 'conflict'])
    await vi.waitFor(() => { expect(remoteAsr).toHaveBeenCalledTimes(2) })

    let disposed = false
    const disposal = runtime.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseRetry('重试后的转写。')
    await disposal

    status = await runtime.status(id)
    expect(status?.stage).toBe('complete')
    expect(status?.transcript).toBe('重试后的转写。\n')
    expect(normalize).toHaveBeenCalledTimes(2)
    await expect(readFile(join(directory, 'original.webm'), 'utf8')).resolves.toBe('preserved source')
  })
})

describe('meeting history projection and reprocessing', () => {
  const ctx = { logger: { warn: vi.fn() } } as unknown as Context

  const persisted = (id: string, extra: Partial<MeetingRecord>): MeetingRecord => ({
    formatVersion: 1,
    id: MeetingId(id),
    stage: 'complete',
    createdAt: '2026-08-19T01:15:00.000Z',
    startedAt: '2026-08-19T01:15:00.000Z',
    endedAt: '2026-08-19T01:20:00.000Z',
    updatedAt: '2026-08-19T01:21:00.000Z',
    originalFilename: 'original.mp4',
    originalMimeType: 'audio/mp4',
    originalBytes: 6,
    completedChunks: 1,
    ...extra,
  })

  it('names each row and reports an unowned nonterminal record as failed without writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-list-runtime-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root, timeZone: 'Asia/Shanghai' })
    const summarized = persisted('meeting-20260820T010000-0000000000c1', {
      createdAt: '2026-08-20T01:00:00.000Z',
      minutesFilename: '2026-08-20_09-00_周会_5m.md',
    })
    const interrupted = persisted('meeting-20260819T091500-0000000000a1', {
      stage: 'transcribing',
      sourceFilename: '晨会录音.mp4',
    })
    for (const record of [summarized, interrupted]) {
      await mkdir(meetingDirectory(config, record.id))
      await writeRecord(config, record)
    }
    const runtime = new MeetingMinutesRuntime(ctx, config)

    await expect(runtime.list()).resolves.toEqual([
      {
        id: summarized.id,
        stage: 'complete',
        name: '2026-08-20_09-00_周会_5m.md',
        createdAt: '2026-08-20T01:00:00.000Z',
      },
      {
        id: interrupted.id,
        stage: 'failed',
        name: '晨会录音.mp4',
        createdAt: '2026-08-19T01:15:00.000Z',
      },
    ])
    const stored: unknown = JSON.parse(
      await readFile(join(meetingDirectory(config, interrupted.id), 'metadata.json'), 'utf8'),
    )
    expect((stored as MeetingRecord).stage).toBe('transcribing')
    await runtime.dispose()
  })

  it('reprocesses a complete meeting in full even when asked to resume, and refuses a queued one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-reprocess-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root, timeZone: 'Asia/Shanghai' })
    const done = persisted('meeting-20260819T091500-0000000000c2', {
      topic: '第一次解析',
      minutesFilename: '2026-08-19_09-15_第一次解析_5m.md',
      summaryMarkdown: '### 决策\n\n第一次。',
      transcriptText: 'transcript.txt',
      transcriptJson: 'transcript.json',
      normalizedAudio: 'audio.mp4',
      totalChunks: 1,
    })
    const waiting = persisted('meeting-20260819T091500-0000000000a2', { stage: 'queued' })
    for (const record of [done, waiting]) {
      await mkdir(meetingDirectory(config, record.id))
      await writeRecord(config, record)
    }
    const directory = meetingDirectory(config, done.id)
    await writeFile(join(directory, 'original.mp4'), 'preserved source')
    const runtime = new MeetingMinutesRuntime(ctx, config, {
      normalize: async () => {
        const chunks = join(directory, '.wav-chunks')
        await mkdir(chunks, { recursive: true })
        const chunk = join(chunks, 'chunk-00000.wav')
        await writeFile(chunk, 'chunk')
        await writeFile(join(directory, 'audio.mp4'), 'mp4')
        return { audioFilename: 'audio.mp4', chunkDirectory: chunks, chunks: [{ path: chunk, startSeconds: 0, endSeconds: config.asrChunkSeconds }] }
      },
      remoteAsr: async () => '第二次转写。',
      summarize: async () => ({ topic: '第二次解析', summaryMarkdown: '### 决策\n\n第二次。' }),
    })

    await expect(runtime.retry(waiting.id, 'resume')).resolves.toEqual({ kind: 'conflict' })
    await expect(runtime.retry(done.id, 'resume')).resolves.toEqual({ kind: 'accepted' })
    await vi.waitFor(async () => { expect((await runtime.status(done.id))?.stage).toBe('complete') })

    const status = await runtime.status(done.id)
    expect(status?.topic).toBe('第二次解析')
    expect(status?.minutesFilename).toBe('2026-08-19_09-15_第二次解析_5m.md')
    expect(status?.transcript).toBe('第二次转写。\n')
    await expect(readFile(join(directory, 'original.mp4'), 'utf8')).resolves.toBe('preserved source')
    await runtime.dispose()
  })

  it('deletes a stored meeting and refuses one the processing queue owns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-delete-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root, timeZone: 'Asia/Shanghai' })
    const stored = persisted('meeting-20260819T091500-0000000000c3', {
      minutesFilename: '2026-08-19_09-15_周会_5m.md',
    })
    const running = persisted('meeting-20260819T091500-0000000000a3', { stage: 'queued' })
    for (const record of [stored, running]) {
      await mkdir(meetingDirectory(config, record.id))
      await writeRecord(config, record)
      await writeFile(join(meetingDirectory(config, record.id), 'original.mp4'), 'source')
    }
    const runtime = new MeetingMinutesRuntime(ctx, config, {
      normalize: async () => { throw new Error('normalization is not exercised here') },
      remoteAsr: async () => '',
      summarize: async () => ({ topic: '未使用', summaryMarkdown: '' }),
    })

    await expect(runtime.remove(MeetingId('meeting-20260819T091500-0000000000ff')))
      .resolves.toEqual({ kind: 'missing' })
    runtime.enqueue(running)
    await expect(runtime.remove(running.id)).resolves.toEqual({ kind: 'conflict' })
    await expect(runtime.remove(stored.id)).resolves.toEqual({ kind: 'deleted' })
    await expect(readFile(join(meetingDirectory(config, stored.id), 'original.mp4'), 'utf8')).rejects.toThrow()
    await expect(runtime.status(stored.id)).resolves.toBeUndefined()

    await runtime.dispose()
    await expect(runtime.status(running.id)).resolves.toMatchObject({ stage: 'failed' })
  })
})
