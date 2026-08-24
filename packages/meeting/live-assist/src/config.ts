/** Configuration validation and explicit runtime default resolution. */

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
  /** Route of the second, slower answer; omission leaves the deep track off entirely. */
  deepProvider?: string
  /** Deep-answer model; must be paired with deepProvider. */
  deepModel?: string
  /** Reasoning effort id the deep route's provider accepts; requires the deep route. */
  deepReasoningEffort?: string
  /** Output-token cap for each deep answer. */
  deepMaxOutputTokens?: number
  /** Deadline for each deep-answer request; deep routes are typically far slower than fast ones. */
  deepRequestTimeoutMs?: number
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

/**
 * Everything one deep-answer request runs against.
 *
 * Its presence is what enables the deep track: a run whose configuration named no deep route
 * makes exactly the one answer request it always did.
 */
export interface DeepAnswerSpec {
  /** LLM route this request is pinned to; never the default Agent route. */
  readonly provider: string
  /** Model within {@link DeepAnswerSpec.provider}. */
  readonly model: string
  /** Reasoning effort passed through to the provider, when the deployment named one. */
  readonly reasoningEffort?: ReasoningEffortId
  /** Output-token cap for this request. */
  readonly maxOutputTokens: number
  /** Deadline for this request. */
  readonly requestTimeoutMs: number
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
  readonly deep?: DeepAnswerSpec
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
  deepProvider: z.string(),
  deepModel: z.string(),
  deepReasoningEffort: z.string(),
  deepMaxOutputTokens: z.number().step(1).min(1).default(4096),
  deepRequestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  answerMaxOutputTokens: z.number().step(1).min(1).default(1600),
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
 * Resolve the optional second answer route.
 *
 * The token cap and deadline are validated even when no deep route is named, so a deployment
 * that mistyped one of them hears about it instead of having it silently discarded.
 * @param config - Loader-validated composition values or a programmatic equivalent.
 * @returns the deep-answer spec, or undefined when the deployment named no deep route.
 */
function resolveDeep(config: Config): DeepAnswerSpec | undefined {
  const provider = config.deepProvider === undefined
    ? undefined
    : requiredString('deepProvider', config.deepProvider)
  const model = config.deepModel === undefined
    ? undefined
    : requiredString('deepModel', config.deepModel)
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('live-assist: deepProvider and deepModel must be configured together')
  }
  const reasoningEffort = config.deepReasoningEffort === undefined
    ? undefined
    : requiredString('deepReasoningEffort', config.deepReasoningEffort)
  const maxOutputTokens = positiveInteger('deepMaxOutputTokens', config.deepMaxOutputTokens ?? 4096)
  const requestTimeoutMs = positiveInteger(
    'deepRequestTimeoutMs',
    config.deepRequestTimeoutMs ?? 300_000,
    MAX_TIMER_DELAY_MS,
  )
  if (provider === undefined || model === undefined) {
    if (reasoningEffort !== undefined) {
      throw new Error('live-assist: deepReasoningEffort requires deepProvider and deepModel')
    }
    return undefined
  }
  return Object.freeze({
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    maxOutputTokens,
    requestTimeoutMs,
  })
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
  const deep = resolveDeep(config)
  const answerMaxOutputTokens = positiveInteger('answerMaxOutputTokens', config.answerMaxOutputTokens ?? 1600)
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
    ...(deep === undefined ? {} : { deep }),
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
