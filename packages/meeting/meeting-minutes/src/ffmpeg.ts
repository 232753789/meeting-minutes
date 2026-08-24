/** FFmpeg-backed normalization and coarse WAV chunk production. */

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import ffmpegPath from 'ffmpeg-static'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from './config.ts'
import { meetingDirectory, NORMALIZED_AUDIO_FILENAME } from './storage.ts'
import type { MeetingRecord } from './types.ts'

const PROCESS_GRACE_MS = 5_000
const DIAGNOSTIC_BYTES = 512 * 1024

async function runFfmpeg(
  ctx: Context,
  executable: string,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const process = ctx.subprocess.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: DIAGNOSTIC_BYTES },
      stderr: { maxBytes: DIAGNOSTIC_BYTES },
    },
    graceMs: PROCESS_GRACE_MS,
    signal,
  })
  const outcome = await process.done
  signal.throwIfAborted()
  if (outcome.exitCode === 0) return
  const stderr = process.collected.stderr?.readFrom(0).text.trim()
  throw new Error(
    `meeting-minutes: FFmpeg exited with ${String(outcome.exitCode)}${stderr === undefined || stderr === '' ? '' : `: ${stderr}`}`,
  )
}

/**
 * Resolve the package-local binary or a configured executable through the subprocess provider.
 * @param ctx - Cordis context carrying the execution-world subprocess provider.
 * @param config - resolved optional executable override.
 * @returns the executable path in the provider's execution world.
 */
export async function resolveFfmpegExecutable(ctx: Context, config: ResolvedConfig): Promise<string> {
  const configured = config.ffmpegExecutable ?? ffmpegPath
  if (configured === null) {
    throw new Error('meeting-minutes: the package-local FFmpeg binary is unavailable; configure ffmpegExecutable')
  }
  return await ctx.subprocess.resolveExecutable(configured)
}

/**
 * Whether the stored recording already is an MP4 container.
 *
 * `originalFilename` is derived from the upload's media type, so its extension decides this.
 */
function isMp4Recording(record: MeetingRecord): boolean {
  return extname(record.originalFilename) === '.mp4'
}

/**
 * Whether a previous attempt already produced this meeting's playback file.
 *
 * `normalizedAudio` is published only after transcoding returned, so the recorded filename names a
 * complete file; a full reprocess clears the field before this runs.
 */
async function transcodedAlready(config: ResolvedConfig, record: MeetingRecord): Promise<boolean> {
  if (record.normalizedAudio === undefined) return false
  try {
    await stat(join(meetingDirectory(config, record.id), record.normalizedAudio))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Provide the MP4 playback file and split 16 kHz mono WAV files for ASR.
 *
 * An MP4 upload is kept as the playback file; only another container is transcoded to MP4/AAC.
 * A playback file a previous attempt already produced is reused, so a retry pays only for the WAV
 * chunks, which are temporary and always cut again.
 * @param ctx - Cordis context carrying the subprocess provider.
 * @param config - resolved FFmpeg and chunk-duration settings.
 * @param record - persisted upload metadata selecting the source file.
 * @param signal - cancellation for both FFmpeg process trees.
 * @returns playback filename plus the temporary WAV chunk paths.
 */
export async function normalizeAndChunk(
  ctx: Context,
  config: ResolvedConfig,
  record: MeetingRecord,
  signal: AbortSignal,
): Promise<{ audioFilename: string; chunkDirectory: string; chunks: string[] }> {
  const directory = meetingDirectory(config, record.id)
  const executable = await resolveFfmpegExecutable(ctx, config)
  const transcode = !isMp4Recording(record) && !await transcodedAlready(config, record)
  const audioFilename = isMp4Recording(record) ? record.originalFilename : NORMALIZED_AUDIO_FILENAME
  if (transcode) {
    await runFfmpeg(ctx, executable, directory, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', record.originalFilename,
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      audioFilename,
    ], signal)
  }

  const chunkDirectory = join(directory, '.wav-chunks')
  await rm(chunkDirectory, { recursive: true, force: true })
  await mkdir(chunkDirectory, { mode: 0o700 })
  const pattern = join(chunkDirectory, 'chunk-%05d.wav')
  try {
    await runFfmpeg(ctx, executable, directory, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', audioFilename,
      '-map', '0:a:0',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 'segment',
      '-segment_time', String(config.asrChunkSeconds),
      '-reset_timestamps', '1',
      pattern,
    ], signal)
    const chunks = (await readdir(chunkDirectory))
      .filter(filename => /^chunk-[0-9]{5}\.wav$/.test(filename))
      .sort()
      .map(filename => join(chunkDirectory, filename))
    if (chunks.length === 0) throw new Error('meeting-minutes: FFmpeg produced no ASR chunks')
    return { audioFilename, chunkDirectory, chunks }
  } catch (error) {
    await rm(chunkDirectory, { recursive: true, force: true })
    throw error
  }
}
