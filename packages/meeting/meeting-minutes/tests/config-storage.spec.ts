import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig, validateLocalModel } from '../src/config.ts'
import {
  durationMinutes,
  listMeetings,
  meetingDisplayName,
  minutesBasename,
  originalFilename,
  renderMinutes,
  sanitizeSourceFilename,
  sanitizeTopic,
  transcriptDownloadName,
  writeRecord,
} from '../src/storage.ts'
import { MeetingId, type MeetingRecord } from '../src/types.ts'

const MODEL_FILES = [
  'config.json', 'generation_config.json', 'chat_template.json', 'preprocessor_config.json',
  'tokenizer_config.json', 'vocab.json', 'merges.txt', 'model.safetensors.index.json',
  'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
] as const

describe('meeting-minutes configuration', () => {
  it('requires the complete two-shard local model directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-model-'))
    await mkdir(join(root, 'model'))
    for (const filename of MODEL_FILES.slice(0, -1)) await writeFile(join(root, 'model', filename), '')
    expect(() => { validateLocalModel(join(root, 'model')) }).toThrow('model-00002-of-00002.safetensors')
    await writeFile(join(root, 'model', MODEL_FILES.at(-1)!), '')
    expect(() => { validateLocalModel(join(root, 'model')) }).not.toThrow()
  })

  it('resolves remote mode without requiring local weights and validates summary route pairs', () => {
    const config = resolveConfig({
      asrMode: 'remote',
      storageRoot: './meetings',
      remoteEndpoint: 'http://127.0.0.1:9000/v1/chat/completions',
      timeZone: 'Asia/Shanghai',
    })
    expect(config.asrMode).toBe('remote')
    expect(config.remoteEndpoint).toBe('http://127.0.0.1:9000/v1/chat/completions')
    expect(config.storageRoot).toMatch(/meetings$/)
    expect(() => resolveConfig({ asrMode: 'remote', summaryProvider: 'one' })).toThrow(
      'summaryProvider and summaryModel',
    )
  })
})

describe('meeting artifacts', () => {
  const record: MeetingRecord = {
    formatVersion: 1,
    id: MeetingId('meeting-20260819T091500-012345abcdef'),
    stage: 'summarizing',
    createdAt: '2026-08-19T01:15:00.000Z',
    startedAt: '2026-08-19T01:15:00.000Z',
    endedAt: '2026-08-19T02:45:00.000Z',
    updatedAt: '2026-08-19T02:45:00.000Z',
    originalFilename: 'original.webm',
    originalMimeType: 'audio/webm;codecs=opus',
    originalBytes: 12,
    completedChunks: 2,
  }

  it('builds the required local-time filename and sanitizes model output', () => {
    expect(sanitizeTopic('  产品 / 路线：评审  ')).toBe('产品-路线-评审')
    expect(minutesBasename(record, '产品 / 路线：评审', 'Asia/Shanghai')).toBe(
      '2026-08-19_09-15_产品-路线-评审_90m.md',
    )
    expect(originalFilename('audio/mp4;codecs=mp4a.40.2')).toBe('original.mp4')
  })

  it('rounds the recorded length up to whole minutes and never below one', () => {
    expect(durationMinutes(record)).toBe(90)
    expect(durationMinutes({ ...record, endedAt: '2026-08-19T01:16:01.000Z' })).toBe(2)
    expect(durationMinutes({ ...record, endedAt: '2026-08-19T01:15:20.000Z' })).toBe(1)
    expect(durationMinutes({ ...record, endedAt: record.startedAt })).toBe(1)
  })

  it('renders audio provenance, summary, and every transcript chunk', async () => {
    const segments = [
      { index: 0, startSeconds: 0, text: '第一段全文。' },
      { index: 1, startSeconds: 300, text: '第二段全文。' },
    ]
    const markdown = renderMinutes(record, 'audio.mp4', '产品路线评审', '### 决策\n\n采用方案 A。', segments)
    expect(markdown).toContain('[original.webm](./original.webm)')
    expect(markdown).toContain('[audio.mp4](./audio.mp4)')
    expect(markdown).toContain('采用方案 A。')
    expect(markdown).toContain('[00:05:00] 第二段全文。')
    const mp4Record = { ...record, originalFilename: 'original.mp4', originalMimeType: 'audio/mp4' }
    const kept = renderMinutes(mp4Record, 'original.mp4', '产品路线评审', '### 决策', segments)
    expect(kept).toContain('[original.mp4](./original.mp4)')
    expect(kept).not.toContain('MP4 音频')
    const root = await mkdtemp(join(tmpdir(), 'meeting-markdown-'))
    const file = join(root, 'minutes.md')
    await writeFile(file, markdown)
    await expect(readFile(file, 'utf8')).resolves.toBe(markdown)
  })
})

describe('meeting history', () => {
  const stored = (id: string, createdAt: string, extra: Partial<MeetingRecord> = {}): MeetingRecord => ({
    formatVersion: 1,
    id: MeetingId(id),
    stage: 'complete',
    createdAt,
    startedAt: createdAt,
    endedAt: createdAt,
    updatedAt: createdAt,
    originalFilename: 'original.mp4',
    originalMimeType: 'audio/mp4',
    originalBytes: 4,
    completedChunks: 1,
    ...extra,
  })

  it('orders meetings newest first, skips unreadable ones, and honors listMaxMeetings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-history-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root })
    const records = [
      stored('meeting-20260819T091500-00000000000a', '2026-08-19T01:15:00.000Z'),
      stored('meeting-20260819T091500-00000000000b', '2026-08-19T01:15:00.000Z'),
      stored('meeting-20260820T010000-00000000000c', '2026-08-20T01:00:00.000Z'),
    ]
    for (const record of records) {
      await mkdir(join(root, record.id))
      await writeRecord(config, record)
    }
    await mkdir(join(root, 'meeting-20260819T091500-0000000000ff'))
    await writeFile(join(root, 'meeting-20260819T091500-0000000000ff', 'metadata.json'), '{"formatVersion":2}')
    await mkdir(join(root, 'not-a-meeting'))
    await writeFile(join(root, 'stray.txt'), '')

    await expect(listMeetings(config).then(listed => listed.map(record => record.id))).resolves.toEqual([
      'meeting-20260820T010000-00000000000c',
      'meeting-20260819T091500-00000000000b',
      'meeting-20260819T091500-00000000000a',
    ])
    const capped = await listMeetings(resolveConfig({ asrMode: 'remote', storageRoot: root, listMaxMeetings: 1 }))
    expect(capped.map(record => record.id)).toEqual(['meeting-20260820T010000-00000000000c'])
  })

  it('reports an empty history before the storage root exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-history-absent-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: join(root, 'never-created') })
    await expect(listMeetings(config)).resolves.toEqual([])
  })

  it('labels a row by minutes filename, then upload name, then stored recording', () => {
    const base = stored('meeting-20260819T091500-00000000000a', '2026-08-19T01:15:00.000Z')
    expect(meetingDisplayName({ ...base, minutesFilename: '2026-08-19_09-15_周会_5m.md' }))
      .toBe('2026-08-19_09-15_周会_5m.md')
    expect(meetingDisplayName({ ...base, sourceFilename: '晨会录音.mp4' })).toBe('晨会录音.mp4')
    expect(meetingDisplayName(base)).toBe('original.mp4')
  })

  it('keeps an upload name display-only and drops path segments and control characters', () => {
    expect(sanitizeSourceFilename('../../etc/晨会 录音.mp4')).toBe('晨会 录音.mp4')
    expect(sanitizeSourceFilename('C:\\Users\\andy\\会议.mp4')).toBe('会议.mp4')
    expect(sanitizeSourceFilename(`${'名'.repeat(200)}.mp4`)).toHaveLength(120)
    expect(sanitizeSourceFilename(' \u0001 ')).toBeUndefined()
  })

  it('names the transcript download after the published minutes', () => {
    const base = stored('meeting-20260819T091500-00000000000a', '2026-08-19T01:15:00.000Z')
    expect(transcriptDownloadName({ ...base, minutesFilename: '2026-08-19_09-15_周会_5m.md' }))
      .toBe('2026-08-19_09-15_周会_5m.txt')
    expect(transcriptDownloadName(base)).toBe('transcript.txt')
  })
})
