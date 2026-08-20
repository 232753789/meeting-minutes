/** Configuration validation and explicit runtime default resolution. */

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Host plugin configuration. */
export interface Config {
  /** Root containing one private directory per meeting. */
  storageRoot?: string
  /** Local Python worker or remote OpenAI-compatible ASR endpoint. */
  asrMode?: 'local' | 'remote'
  /** Complete local Qwen3-ASR-1.7B model directory. */
  localModelPath?: string
  /** Python executable hosting the persistent qwen-asr worker. */
  pythonExecutable?: string
  /** Local inference device; auto tries CUDA, then MPS, then CPU. */
  localDevice?: 'auto' | 'cuda' | 'mps' | 'cpu'
  /** Qwen ASR language name, or `auto` for language detection. */
  language?: string
  /** Normalized WAV chunk duration. */
  asrChunkSeconds?: number
  /** Deadline for each local or remote ASR chunk. */
  asrRequestTimeoutMs?: number
  /** Idle time after which the persistent local ASR process is stopped. */
  asrIdleShutdownMs?: number
  /** Generated-token cap for each ASR chunk. */
  asrMaxOutputTokens?: number
  /** Complete remote chat-completions endpoint. */
  remoteEndpoint?: string
  /** Model id sent to the remote ASR server. */
  remoteModel?: string
  /** Environment variable carrying the optional remote bearer token. */
  remoteApiKeyEnv?: string
  /** Explicit summary route; omission uses the current default Agent route. */
  summaryProvider?: string
  /** Explicit summary model; must be paired with summaryProvider. */
  summaryModel?: string
  /** Maximum UTF-8 input bytes for each hierarchical summary request. */
  summaryMaxInputBytes?: number
  /** Output-token cap for partial and final summary requests. */
  summaryMaxOutputTokens?: number
  /** Maximum hierarchical reduction rounds before an oversized summary fails. */
  summaryMaxReductionRounds?: number
  /** Deadline for each summary request. */
  summaryRequestTimeoutMs?: number
  /** Largest accepted browser recording body. */
  maxUploadBytes?: number
  /** Newest meetings returned by the history list route. */
  listMaxMeetings?: number
  /** IANA time zone used in the final Markdown filename. */
  timeZone?: string
  /** Optional FFmpeg executable override. */
  ffmpegExecutable?: string
}

/** Fully resolved immutable runtime settings. */
export interface ResolvedConfig {
  readonly storageRoot: string
  readonly asrMode: 'local' | 'remote'
  readonly localModelPath: string
  readonly pythonExecutable: string
  readonly localDevice: 'auto' | 'cuda' | 'mps' | 'cpu'
  readonly language: string
  readonly asrChunkSeconds: number
  readonly asrRequestTimeoutMs: number
  readonly asrIdleShutdownMs: number
  readonly asrMaxOutputTokens: number
  readonly remoteEndpoint: string
  readonly remoteModel: string
  readonly remoteApiKeyEnv: string
  readonly summaryProvider?: string
  readonly summaryModel?: string
  readonly summaryMaxInputBytes: number
  readonly summaryMaxOutputTokens: number
  readonly summaryMaxReductionRounds: number
  readonly summaryRequestTimeoutMs: number
  readonly maxUploadBytes: number
  readonly listMaxMeetings: number
  readonly timeZone: string
  readonly ffmpegExecutable?: string
}

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

const DEFAULT_REMOTE_ENDPOINT = 'http://127.0.0.1:8000/v1/chat/completions'
const DEFAULT_REMOTE_MODEL = 'Qwen/Qwen3-ASR-1.7B'
const MIN_SUMMARY_INPUT_BYTES = 8 * 1024

/** Schemastery declaration for profile composition. */
export const Config: z<Config> = z.object({
  storageRoot: z.string(),
  asrMode: z.union(['local', 'remote'] as const).default('local'),
  localModelPath: z.string(),
  pythonExecutable: z.string().default('python3'),
  localDevice: z.union(['auto', 'cuda', 'mps', 'cpu'] as const).default('auto'),
  language: z.string().default('Chinese'),
  asrChunkSeconds: z.number().step(1).min(1).default(300),
  asrRequestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(1_800_000),
  asrIdleShutdownMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  asrMaxOutputTokens: z.number().step(1).min(1).default(2_048),
  remoteEndpoint: z.string().default(DEFAULT_REMOTE_ENDPOINT),
  remoteModel: z.string().default(DEFAULT_REMOTE_MODEL),
  remoteApiKeyEnv: z.string().default('QWEN_ASR_API_KEY'),
  summaryProvider: z.string(),
  summaryModel: z.string(),
  summaryMaxInputBytes: z.number().step(1).min(MIN_SUMMARY_INPUT_BYTES).default(65_536),
  summaryMaxOutputTokens: z.number().step(1).min(1).default(4_096),
  summaryMaxReductionRounds: z.number().step(1).min(1).default(8),
  summaryRequestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
  maxUploadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2_147_483_648),
  listMaxMeetings: z.number().step(1).min(1).default(200),
  timeZone: z.string(),
  ffmpegExecutable: z.string(),
})

function requiredString(name: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`meeting-minutes: ${name} must be a non-empty string`)
  return trimmed
}

function positiveInteger(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`meeting-minutes: ${name} must be a positive integer no greater than ${String(maximum)}`)
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
    // The diagnostic below owns the missing-path case and lists the required fix.
  }
  if (!directory) {
    throw new Error(`meeting-minutes: localModelPath is not a directory: ${modelPath}`)
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
    throw new Error(`meeting-minutes: local Qwen model is incomplete at ${modelPath}; missing ${missing.join(', ')}`)
  }
}

/**
 * Resolve defaults once and reject configuration errors before routes are registered.
 * @param config - Loader-validated composition values or a programmatic equivalent.
 * @returns the immutable runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const storageRoot = resolve(expandHomePath(config.storageRoot ?? dshHomePath('meeting-minutes')))
  const asrMode = config.asrMode ?? 'local'
  const localModelPath = resolve(expandHomePath(config.localModelPath ?? dshHomePath('models', 'Qwen3-ASR-1.7B')))
  const pythonExecutable = requiredString('pythonExecutable', config.pythonExecutable ?? 'python3')
  const localDevice = config.localDevice ?? 'auto'
  const language = requiredString('language', config.language ?? 'Chinese')
  const asrChunkSeconds = positiveInteger('asrChunkSeconds', config.asrChunkSeconds ?? 300)
  const asrRequestTimeoutMs = positiveInteger(
    'asrRequestTimeoutMs',
    config.asrRequestTimeoutMs ?? 1_800_000,
    MAX_TIMER_DELAY_MS,
  )
  const asrIdleShutdownMs = positiveInteger(
    'asrIdleShutdownMs',
    config.asrIdleShutdownMs ?? 120_000,
    MAX_TIMER_DELAY_MS,
  )
  const asrMaxOutputTokens = positiveInteger('asrMaxOutputTokens', config.asrMaxOutputTokens ?? 2_048)
  const remoteEndpoint = requiredString('remoteEndpoint', config.remoteEndpoint ?? DEFAULT_REMOTE_ENDPOINT)
  const remoteModel = requiredString('remoteModel', config.remoteModel ?? DEFAULT_REMOTE_MODEL)
  const remoteApiKeyEnv = requiredString('remoteApiKeyEnv', config.remoteApiKeyEnv ?? 'QWEN_ASR_API_KEY')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(remoteApiKeyEnv)) {
    throw new Error('meeting-minutes: remoteApiKeyEnv must be an environment-variable name')
  }
  let endpoint: URL
  try {
    endpoint = new URL(remoteEndpoint)
  } catch {
    throw new Error(`meeting-minutes: remoteEndpoint is not a URL: ${remoteEndpoint}`)
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('meeting-minutes: remoteEndpoint must use http or https')
  }
  const summaryProvider = config.summaryProvider === undefined
    ? undefined
    : requiredString('summaryProvider', config.summaryProvider)
  const summaryModel = config.summaryModel === undefined
    ? undefined
    : requiredString('summaryModel', config.summaryModel)
  if ((summaryProvider === undefined) !== (summaryModel === undefined)) {
    throw new Error('meeting-minutes: summaryProvider and summaryModel must be configured together')
  }
  const summaryMaxInputBytes = positiveInteger(
    'summaryMaxInputBytes',
    config.summaryMaxInputBytes ?? 65_536,
  )
  if (summaryMaxInputBytes < MIN_SUMMARY_INPUT_BYTES) {
    throw new Error(`meeting-minutes: summaryMaxInputBytes must be at least ${String(MIN_SUMMARY_INPUT_BYTES)}`)
  }
  const summaryMaxOutputTokens = positiveInteger(
    'summaryMaxOutputTokens',
    config.summaryMaxOutputTokens ?? 4_096,
  )
  const summaryMaxReductionRounds = positiveInteger(
    'summaryMaxReductionRounds',
    config.summaryMaxReductionRounds ?? 8,
  )
  const summaryRequestTimeoutMs = positiveInteger(
    'summaryRequestTimeoutMs',
    config.summaryRequestTimeoutMs ?? 600_000,
    MAX_TIMER_DELAY_MS,
  )
  const maxUploadBytes = positiveInteger('maxUploadBytes', config.maxUploadBytes ?? 2_147_483_648)
  const listMaxMeetings = positiveInteger('listMaxMeetings', config.listMaxMeetings ?? 200)
  const timeZone = requiredString(
    'timeZone',
    config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format()
  } catch {
    throw new Error(`meeting-minutes: timeZone is not a supported IANA zone: ${timeZone}`)
  }
  const ffmpegExecutable = config.ffmpegExecutable === undefined
    ? undefined
    : requiredString('ffmpegExecutable', config.ffmpegExecutable)
  if (asrMode === 'local') validateLocalModel(localModelPath)
  return Object.freeze({
    storageRoot,
    asrMode,
    localModelPath,
    pythonExecutable,
    localDevice,
    language,
    asrChunkSeconds,
    asrRequestTimeoutMs,
    asrIdleShutdownMs,
    asrMaxOutputTokens,
    remoteEndpoint: endpoint.toString(),
    remoteModel,
    remoteApiKeyEnv,
    ...(summaryProvider === undefined ? {} : { summaryProvider, summaryModel: summaryModel as string }),
    summaryMaxInputBytes,
    summaryMaxOutputTokens,
    summaryMaxReductionRounds,
    summaryRequestTimeoutMs,
    maxUploadBytes,
    listMaxMeetings,
    timeZone,
    ...(ffmpegExecutable === undefined ? {} : { ffmpegExecutable }),
  })
}
