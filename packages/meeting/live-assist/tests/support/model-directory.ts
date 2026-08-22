/** A complete-looking Qwen model directory, so `resolveConfig` gets past its load-time check. */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODEL_FILES = [
  'config.json', 'generation_config.json', 'chat_template.json', 'preprocessor_config.json',
  'tokenizer_config.json', 'vocab.json', 'merges.txt', 'model.safetensors.index.json',
  'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
] as const

let cached: Promise<string> | undefined

/**
 * Create (once per process) a directory carrying every file the model check requires.
 * @returns the absolute directory path.
 */
export function modelDirectory(): Promise<string> {
  cached ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-assist-model-'))
    const path = join(root, 'model')
    await mkdir(path)
    for (const filename of MODEL_FILES) await writeFile(join(path, filename), '')
    return path
  })()
  return cached
}
