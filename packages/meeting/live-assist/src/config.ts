/** Configuration validation and explicit runtime default resolution. */

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Host plugin configuration. */
export interface Config {
  /** Complete local Qwen3-ASR model directory. */
  localModelPath?: string
  /** Python executable hosting the persistent recognizer worker. */
  pythonExecutable?: string
  /** Local inference device; auto tries CUDA, then MPS, then CPU. */
  localDevice?: 'auto' | 'cuda' | 'mps' | 'cpu'
  /** Qwen ASR language name, or `auto` for language detection. */
  language?: string
  /** Generated-token cap for each transcribed utterance. */
  asrMaxOutputTokens?: number
  /** silero-vad speech probability above which a window counts as speech. */
  vadThreshold?: number
  /** Trailing silence that ends an utterance; the dominant term in answer latency. */
  vadMinSilenceMs?: number
  /** Audio kept on each side of a detected utterance. */
  vadSpeechPadMs?: number
  /** Shortest speech, excluding padding, that is transcribed rather than discarded as noise. */
  minUtteranceMs?: number
  /** Longest uninterrupted speech before it is cut and transcribed anyway. */
  maxUtteranceMs?: number
  /** Explicit answer route; omission uses the current default Agent route. */
  answerProvider?: string
  /** Explicit answer model; must be paired with answerProvider. */
  answerModel?: string
  /** Output-token cap for each answer. */
  answerMaxOutputTokens?: number
  /** Output-token cap for the session title derived from the background material. */
  titleMaxOutputTokens?: number
  /** Deadline for each answer request. */
  answerRequestTimeoutMs?: number
  /** Largest accepted background-material document. */
  maxBackgroundBytes?: number
  /** Answered questions retained as context for the next answer. */
  historyTurns?: number
  /** Newest interviewee-typed messages in the session that steer later answers. */
  noteTurns?: number
  /** Concurrent live sessions this Host accepts. */
  maxSessions?: number
  /** Idle time after which the recognizer process is stopped, releasing accelerator memory. */
  workerIdleShutdownMs?: number
}

/** Fully resolved immutable runtime settings. */
export interface ResolvedConfig {
  readonly localModelPath: string
  readonly pythonExecutable: string
  readonly localDevice: 'auto' | 'cuda' | 'mps' | 'cpu'
  readonly language: string
  readonly asrMaxOutputTokens: number
  readonly vadThreshold: number
  readonly vadMinSilenceMs: number
  readonly vadSpeechPadMs: number
  readonly minUtteranceMs: number
  readonly maxUtteranceMs: number
  readonly answerProvider?: string
  readonly answerModel?: string
  readonly answerMaxOutputTokens: number
  readonly titleMaxOutputTokens: number
  readonly answerRequestTimeoutMs: number
  readonly maxBackgroundBytes: number
  readonly historyTurns: number
  readonly noteTurns: number
  readonly maxSessions: number
  readonly workerIdleShutdownMs: number
}

/* jscpd:ignore-start */
const REQUIRED_MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'chat_template.json',
  'preprocessor_config.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
  'model.safetensors.index.json',
  'model-00001-of-00002.safetensors',
  'model-00002-of-00002.safetensors',
] as const
/* jscpd:ignore-end */

/** Schemastery declaration for profile composition. */
export const Config: z<Config> = z.object({
  localModelPath: z.string(),
  pythonExecutable: z.string().default('python3'),
  localDevice: z.union(['auto', 'cuda', 'mps', 'cpu'] as const).default('auto'),
  language: z.string().default('Chinese'),
  asrMaxOutputTokens: z.number().step(1).min(1).default(256),
  vadThreshold: z.number().min(0).max(1).default(0.5),
  vadMinSilenceMs: z.number().step(1).min(1).default(700),
  vadSpeechPadMs: z.number().step(1).min(0).default(200),
  minUtteranceMs: z.number().step(1).min(1).default(400),
  maxUtteranceMs: z.number().step(1).min(1).default(20_000),
  answerProvider: z.string(),
  answerModel: z.string(),
  answerMaxOutputTokens: z.number().step(1).min(1).default(800),
  titleMaxOutputTokens: z.number().step(1).min(1).default(64),
  answerRequestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxBackgroundBytes: z.number().step(1).min(1).default(32_768),
  historyTurns: z.number().step(1).min(0).default(8),
  noteTurns: z.number().step(1).min(0).default(6),
  maxSessions: z.number().step(1).min(1).default(2),
  workerIdleShutdownMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
})

function requiredString(name: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`live-assist: ${name} must be a non-empty string`)
  return trimmed
}

function positiveInteger(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`live-assist: ${name} must be a positive integer no greater than ${String(maximum)}`)
  }
  return value
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`live-assist: ${name} must be a non-negative integer`)
  }
  return value
}

/**
 * Verify that a local path contains both Qwen weight shards and their companion files.
 * @param modelPath - absolute candidate model directory.
 */
export function validateLocalModel(modelPath: string): void {
  let directory = false
  try {
    directory = statSync(modelPath).isDirectory()
  } catch {
    // The diagnostic below owns the missing-path case and names the required fix.
  }
  if (!directory) {
    throw new Error(`live-assist: localModelPath is not a directory: ${modelPath}`)
  }
  const missing = REQUIRED_MODEL_FILES.filter((filename) => {
    try {
      accessSync(resolve(modelPath, filename), fsConstants.R_OK)
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(`live-assist: local Qwen model is incomplete at ${modelPath}; missing ${missing.join(', ')}`)
  }
}

/**
 * Resolve defaults once and reject configuration errors before the socket route is registered.
 * @param config - Loader-validated composition values or a programmatic equivalent.
 * @returns the immutable runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const localModelPath = resolve(expandHomePath(config.localModelPath ?? dshHomePath('models', 'Qwen3-ASR-1.7B')))
  const pythonExecutable = requiredString('pythonExecutable', config.pythonExecutable ?? 'python3')
  const localDevice = config.localDevice ?? 'auto'
  const language = requiredString('language', config.language ?? 'Chinese')
  const asrMaxOutputTokens = positiveInteger('asrMaxOutputTokens', config.asrMaxOutputTokens ?? 256)
  const vadThreshold = config.vadThreshold ?? 0.5
  if (!Number.isFinite(vadThreshold) || vadThreshold <= 0 || vadThreshold >= 1) {
    throw new Error('live-assist: vadThreshold must be between 0 and 1, exclusive')
  }
  const vadMinSilenceMs = positiveInteger('vadMinSilenceMs', config.vadMinSilenceMs ?? 700)
  const vadSpeechPadMs = nonNegativeInteger('vadSpeechPadMs', config.vadSpeechPadMs ?? 200)
  const minUtteranceMs = positiveInteger('minUtteranceMs', config.minUtteranceMs ?? 400)
  const maxUtteranceMs = positiveInteger('maxUtteranceMs', config.maxUtteranceMs ?? 20_000)
  if (maxUtteranceMs <= minUtteranceMs) {
    throw new Error('live-assist: maxUtteranceMs must exceed minUtteranceMs')
  }
  const answerProvider = config.answerProvider === undefined
    ? undefined
    : requiredString('answerProvider', config.answerProvider)
  const answerModel = config.answerModel === undefined
    ? undefined
    : requiredString('answerModel', config.answerModel)
  if ((answerProvider === undefined) !== (answerModel === undefined)) {
    throw new Error('live-assist: answerProvider and answerModel must be configured together')
  }
  const answerMaxOutputTokens = positiveInteger('answerMaxOutputTokens', config.answerMaxOutputTokens ?? 800)
  const titleMaxOutputTokens = positiveInteger('titleMaxOutputTokens', config.titleMaxOutputTokens ?? 64)
  const answerRequestTimeoutMs = positiveInteger(
    'answerRequestTimeoutMs',
    config.answerRequestTimeoutMs ?? 120_000,
    MAX_TIMER_DELAY_MS,
  )
  const maxBackgroundBytes = positiveInteger('maxBackgroundBytes', config.maxBackgroundBytes ?? 32_768)
  const historyTurns = nonNegativeInteger('historyTurns', config.historyTurns ?? 8)
  const noteTurns = nonNegativeInteger('noteTurns', config.noteTurns ?? 6)
  const maxSessions = positiveInteger('maxSessions', config.maxSessions ?? 2)
  const workerIdleShutdownMs = positiveInteger(
    'workerIdleShutdownMs',
    config.workerIdleShutdownMs ?? 300_000,
    MAX_TIMER_DELAY_MS,
  )
  validateLocalModel(localModelPath)
  return Object.freeze({
    localModelPath,
    pythonExecutable,
    localDevice,
    language,
    asrMaxOutputTokens,
    vadThreshold,
    vadMinSilenceMs,
    vadSpeechPadMs,
    minUtteranceMs,
    maxUtteranceMs,
    ...(answerProvider === undefined ? {} : { answerProvider, answerModel: answerModel as string }),
    answerMaxOutputTokens,
    titleMaxOutputTokens,
    answerRequestTimeoutMs,
    maxBackgroundBytes,
    historyTurns,
    noteTurns,
    maxSessions,
    workerIdleShutdownMs,
  })
}
