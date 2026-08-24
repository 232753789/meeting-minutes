import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig, validateLocalModel } from '../src/config.ts'

/** `Config` names both the interface and its schemastery value; the parameter type is unambiguous. */
type ConfigInput = Parameters<typeof resolveConfig>[0]

const MODEL_FILES = [
  'config.json', 'generation_config.json', 'chat_template.json', 'preprocessor_config.json',
  'tokenizer_config.json', 'vocab.json', 'merges.txt', 'model.safetensors.index.json',
  'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
] as const

let modelPath: string
let incompletePath: string
let filePath: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-assist-config-'))
  modelPath = join(root, 'model')
  await mkdir(modelPath)
  for (const filename of MODEL_FILES) await writeFile(join(modelPath, filename), '')
  incompletePath = join(root, 'partial')
  await mkdir(incompletePath)
  await writeFile(join(incompletePath, 'config.json'), '')
  filePath = join(root, 'a-file')
  await writeFile(filePath, '')
})

function resolve(overrides: ConfigInput = {}) {
  return resolveConfig(Object.assign({ localModelPath: modelPath }, overrides))
}

describe('validateLocalModel', () => {
  it('accepts a complete model directory', () => {
    expect(() => { validateLocalModel(modelPath) }).not.toThrow()
  })

  it('names every missing weight file', () => {
    expect(() => { validateLocalModel(incompletePath) })
      .toThrow(/incomplete .*missing generation_config\.json/s)
  })

  it('rejects a path that is not a directory', () => {
    expect(() => { validateLocalModel(filePath) }).toThrow(/is not a directory/)
  })

  it('rejects a path that does not exist', () => {
    expect(() => { validateLocalModel(join(modelPath, 'nope')) }).toThrow(/is not a directory/)
  })
})

describe('resolveConfig', () => {
  it('fills every default', () => {
    expect(resolve()).toMatchObject({
      pythonExecutable: 'python3',
      localDevice: 'auto',
      language: 'Chinese',
      asrMaxOutputTokens: 256,
      vadThreshold: 0.5,
      vadMinSilenceMs: 700,
      vadSpeechPadMs: 200,
      minUtteranceMs: 400,
      maxUtteranceMs: 20_000,
      answerMaxOutputTokens: 1600,
      answerRequestTimeoutMs: 120_000,
      maxBackgroundBytes: 32_768,
      historyTurns: 8,
      maxSessions: 2,
      workerIdleShutdownMs: 300_000,
    })
  })

  it('freezes the resolved configuration', () => {
    expect(Object.isFrozen(resolve())).toBe(true)
  })

  it('omits the answer route unless both halves are configured', () => {
    expect(resolve()).not.toHaveProperty('answerProvider')
    expect(resolve({ answerProvider: 'deepseek', answerModel: 'deepseek-chat' }))
      .toMatchObject({ answerProvider: 'deepseek', answerModel: 'deepseek-chat' })
  })

  it.each([
    ['answerProvider without answerModel', { answerProvider: 'deepseek' }, /configured together/],
    ['answerModel without answerProvider', { answerModel: 'deepseek-chat' }, /configured together/],
    ['a blank pythonExecutable', { pythonExecutable: '  ' }, /pythonExecutable must be a non-empty/],
    ['a blank language', { language: '' }, /language must be a non-empty/],
    ['a zero vadThreshold', { vadThreshold: 0 }, /vadThreshold must be between 0 and 1/],
    ['a vadThreshold of 1', { vadThreshold: 1 }, /vadThreshold must be between 0 and 1/],
    ['a non-finite vadThreshold', { vadThreshold: Number.NaN }, /vadThreshold must be between 0 and 1/],
    ['a fractional asrMaxOutputTokens', { asrMaxOutputTokens: 1.5 }, /asrMaxOutputTokens must be a positive integer/],
    ['a zero minUtteranceMs', { minUtteranceMs: 0 }, /minUtteranceMs must be a positive integer/],
    ['a negative vadSpeechPadMs', { vadSpeechPadMs: -1 }, /vadSpeechPadMs must be a non-negative integer/],
    ['a negative historyTurns', { historyTurns: -1 }, /historyTurns must be a non-negative integer/],
    ['maxUtteranceMs below minUtteranceMs', { minUtteranceMs: 5_000, maxUtteranceMs: 1_000 }, /maxUtteranceMs must exceed/],
    ['a blank answerProvider', { answerProvider: ' ', answerModel: 'm' }, /answerProvider must be a non-empty/],
    ['a blank answerModel', { answerProvider: 'p', answerModel: ' ' }, /answerModel must be a non-empty/],
    ['deepProvider without deepModel', { deepProvider: 'deepseek' }, /deepProvider and deepModel must be configured together/],
    ['deepModel without deepProvider', { deepModel: 'deepseek-reasoner' }, /deepProvider and deepModel must be configured together/],
    ['a blank deepProvider', { deepProvider: ' ', deepModel: 'm' }, /deepProvider must be a non-empty/],
    ['a blank deepModel', { deepProvider: 'p', deepModel: ' ' }, /deepModel must be a non-empty/],
    ['a blank deepReasoningEffort', { deepProvider: 'p', deepModel: 'm', deepReasoningEffort: ' ' }, /deepReasoningEffort must be a non-empty/],
    ['deepReasoningEffort without a deep route', { deepReasoningEffort: 'high' }, /deepReasoningEffort requires deepProvider and deepModel/],
    ['a fractional deepMaxOutputTokens', { deepMaxOutputTokens: 1.5 }, /deepMaxOutputTokens must be a positive integer/],
    ['a zero deepRequestTimeoutMs', { deepRequestTimeoutMs: 0 }, /deepRequestTimeoutMs must be a positive integer/],
  ])('rejects %s', (_label, overrides, expected) => {
    expect(() => resolve(overrides as ConfigInput)).toThrow(expected)
  })

  it('leaves the deep track off unless both halves are configured', () => {
    expect(resolve()).not.toHaveProperty('deep')
    expect(resolve({ deepProvider: 'deepseek', deepModel: 'deepseek-reasoner' }).deep)
      .toMatchObject({
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        maxOutputTokens: 4096,
        requestTimeoutMs: 300_000,
      })
  })

  it('freezes the deep route and omits an unnamed reasoning effort', () => {
    const deep = resolve({ deepProvider: 'p', deepModel: 'm' }).deep
    expect(Object.isFrozen(deep)).toBe(true)
    expect(deep).not.toHaveProperty('reasoningEffort')
    expect(resolve({ deepProvider: 'p', deepModel: 'm', deepReasoningEffort: 'high' }).deep)
      .toMatchObject({ reasoningEffort: 'high' })
  })

  it('accepts a zero vadSpeechPadMs and a zero historyTurns', () => {
    expect(resolve({ vadSpeechPadMs: 0, historyTurns: 0 }))
      .toMatchObject({ vadSpeechPadMs: 0, historyTurns: 0 })
  })

  it('refuses to resolve against an incomplete model', () => {
    expect(() => resolveConfig({ localModelPath: incompletePath })).toThrow(/incomplete/)
  })
})

describe('resolveConfig default model path', () => {
  it('falls back to the DSH home model directory', () => {
    // No localModelPath: the default path is resolved and then rejected as absent, which is
    // exactly the load-time failure a machine without the model should see.
    expect(() => resolveConfig({})).toThrow(/Qwen3-ASR-1\.7B/)
  })
})
