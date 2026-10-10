import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { normalizeAndChunk, splitDiarizedAudio } from '../src/ffmpeg.ts'
import { meetingDirectory } from '../src/storage.ts'
import { MeetingId, type MeetingRecord } from '../src/types.ts'

const ID = MeetingId('meeting-20260819T091500-012345abcdef')

/** Collects every FFmpeg argv and materializes the WAV chunks the segment invocation would write. */
function fakeSubprocess(runs: string[][], exitCode = 0, stderr = ''): Context {
  return {
    subprocess: {
      resolveExecutable: (command: string) => Promise.resolve(command),
      spawn: (spec: SubprocessSpawnSpec) => {
        const argv = spec.argv.slice()
        runs.push(argv)
        const pattern = argv.at(-1)!
        const chunked = argv.includes('segment')
        const written = chunked && exitCode === 0
          ? writeFile(pattern.replace('%05d', '00000'), 'wav')
          : Promise.resolve()
        return {
          collected: { stderr: { readFrom: () => ({ text: stderr }) } },
          done: written.then(() => ({ exitCode, signal: null })),
        } as unknown as SubprocessHandle
      },
    },
  } as unknown as Context
}

async function meeting(originalFilename: string): Promise<{ config: ReturnType<typeof resolveConfig>; record: MeetingRecord }> {
  const root = await mkdtemp(join(tmpdir(), 'meeting-ffmpeg-'))
  const config = resolveConfig({ asrMode: 'remote', storageRoot: root, ffmpegExecutable: '/usr/bin/ffmpeg' })
  await mkdir(meetingDirectory(config, ID), { recursive: true })
  await writeFile(join(meetingDirectory(config, ID), originalFilename), 'source')
  const record: MeetingRecord = {
    formatVersion: 1,
    id: ID,
    stage: 'normalizing',
    createdAt: '2026-08-19T01:15:00.000Z',
    startedAt: '2026-08-19T01:15:00.000Z',
    endedAt: '2026-08-19T01:20:00.000Z',
    updatedAt: '2026-08-19T01:20:00.000Z',
    originalFilename,
    originalMimeType: originalFilename.endsWith('.mp4') ? 'audio/mp4' : 'audio/webm',
    originalBytes: 6,
    completedChunks: 0,
  }
  return { config, record }
}

describe('meeting audio preparation', () => {
  it('transcodes a non-MP4 recording before chunking it', async () => {
    const { config, record } = await meeting('original.webm')
    const runs: string[][] = []
    const result = await normalizeAndChunk(fakeSubprocess(runs), config, record, AbortSignal.timeout(5_000))

    expect(result.audioFilename).toBe('audio.mp4')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual(expect.arrayContaining(['-i', 'original.webm', 'audio.mp4']))
    expect(runs[1]).toEqual(expect.arrayContaining(['-i', 'audio.mp4']))
    expect(result.chunks).toHaveLength(1)
    expect(await readdir(result.chunkDirectory)).toEqual(['chunk-00000.wav'])
  })

  it('keeps an MP4 recording as the playback file and chunks it directly', async () => {
    const { config, record } = await meeting('original.mp4')
    const runs: string[][] = []
    const result = await normalizeAndChunk(fakeSubprocess(runs), config, record, AbortSignal.timeout(5_000))

    expect(result.audioFilename).toBe('original.mp4')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual(expect.arrayContaining(['-i', 'original.mp4']))
    expect(await readdir(meetingDirectory(config, ID))).not.toContain('audio.mp4')
    expect(result.chunks).toHaveLength(1)
  })

  it('reuses a playback file a previous attempt already produced', async () => {
    const { config, record } = await meeting('original.webm')
    await writeFile(join(meetingDirectory(config, ID), 'audio.mp4'), 'transcoded')
    record.normalizedAudio = 'audio.mp4'
    const runs: string[][] = []
    const result = await normalizeAndChunk(fakeSubprocess(runs), config, record, AbortSignal.timeout(5_000))

    expect(result.audioFilename).toBe('audio.mp4')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual(expect.arrayContaining(['-i', 'audio.mp4', '-f', 'segment']))
  })

  it('transcodes again when the recorded playback file is gone', async () => {
    const { config, record } = await meeting('original.webm')
    record.normalizedAudio = 'audio.mp4'
    const runs: string[][] = []
    const result = await normalizeAndChunk(fakeSubprocess(runs), config, record, AbortSignal.timeout(5_000))

    expect(result.audioFilename).toBe('audio.mp4')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual(expect.arrayContaining(['-i', 'original.webm', 'audio.mp4']))
  })

  it('surfaces a playback file that cannot be inspected instead of transcoding over it', async () => {
    const { config, record } = await meeting('original.webm')
    record.normalizedAudio = 'original.webm/audio.mp4'
    await expect(normalizeAndChunk(
      fakeSubprocess([]),
      config,
      record,
      AbortSignal.timeout(5_000),
    )).rejects.toThrow('ENOTDIR')
  })

  it('reports FFmpeg diagnostics and removes the chunk directory on failure', async () => {
    const { config, record } = await meeting('original.mp4')
    const runs: string[][] = []
    await expect(normalizeAndChunk(
      fakeSubprocess(runs, 1, 'Invalid data found when processing input'),
      config,
      record,
      AbortSignal.timeout(5_000),
    )).rejects.toThrow('Invalid data found when processing input')
    expect(await readdir(meetingDirectory(config, ID))).not.toContain('.wav-chunks')
  })

  it('cuts one ASR file for each diarized speaker interval', async () => {
    const { config, record } = await meeting('original.mp4')
    const runs: string[][] = []
    const result = await splitDiarizedAudio(
      fakeSubprocess(runs),
      config,
      record,
      'original.mp4',
      [
        { startSeconds: 0, endSeconds: 1.5, speaker: 'speaker-1' },
        { startSeconds: 1.5, endSeconds: 3, speaker: 'speaker-2' },
      ],
      AbortSignal.timeout(5_000),
    )

    expect(result.chunks[0]?.path).toContain('speaker-00000.wav')
    expect(result.chunks[0]?.speaker).toBe('speaker-1')
    expect(result.chunks[1]?.path).toContain('speaker-00001.wav')
    expect(result.chunks[1]?.speaker).toBe('speaker-2')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual(expect.arrayContaining(['-ss', '0', '-t', '1.5', '-i', 'original.mp4']))
  })
})
