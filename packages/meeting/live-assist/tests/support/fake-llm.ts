/** A Context whose `llm.stream` replays scripted chunks, one script per request. */

import type { Context } from '@deepseek-ai/cordis'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** One scripted model response. */
export interface Script {
  /** Text deltas emitted in order. */
  readonly deltas: readonly string[]
  /** Terminal reason; defaults to a normal stop. */
  readonly finish?: FinishReason
  /** Omit the terminal chunk entirely, as a truncated transport would. */
  readonly omitFinish?: boolean
  /** Throw instead of yielding. */
  readonly throws?: Error
  /** Throw a non-Error value, as a foreign provider can. */
  readonly throwsValue?: string
  /** Reasoning effort the default route reports. */
  readonly reasoningEffort?: string
  /** Emit block framing around the deltas, as a real adapter does. */
  readonly withBlockFraming?: boolean
}

/** What the fake recorded about the requests it served. */
export interface LlmRecorder {
  readonly ctx: Context
  readonly requests: GenerateOptions[]
}

/**
 * Build a Context that answers `llm.stream` from `scripts`, in order.
 * @param scripts - one entry per expected request; the last entry repeats.
 * @returns the context and the recorded requests.
 */
export function llmContext(scripts: readonly Script[]): LlmRecorder {
  const requests: GenerateOptions[] = []
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: {
      currentSelection: () => ({
        provider: 'fake',
        model: 'fake-model',
        ...(scripts[0]?.reasoningEffort === undefined ? {} : { reasoningEffort: scripts[0].reasoningEffort }),
      }),
    },
    llm: {
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        const index = Math.min(requests.length, scripts.length - 1)
        requests.push(options)
        const script = scripts[index] as Script
        return (async function* replay() {
          if (script.throws !== undefined) throw script.throws
          // A provider throwing a bare string is what the session must still report.
          if (script.throwsValue !== undefined) throw script.throwsValue
          if (script.withBlockFraming === true) {
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          for (const text of script.deltas) {
            await Promise.resolve()
            yield { type: 'text-delta', index: 0, text }
          }
          if (script.omitFinish === true) return
          yield { type: 'finish', reason: script.finish ?? { kind: 'stop' } }
        })()
      },
    },
  } as unknown as Context
  return { ctx, requests }
}
