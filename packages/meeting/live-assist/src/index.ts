/**
 * Live-assist Host plugin: counterpart-only audio in over a loopback WebSocket,
 * silero-vad segmentation, local Qwen3-ASR transcription, and streamed answer suggestions.
 * @module @deepseek-ai/dsh-live-assist
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Config, resolveConfig } from './config.ts'
import { install } from './lifecycle.ts'

export { Config, resolveConfig, validateLocalModel } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export type {} from './events.ts'
export { LIVE_ASSIST_SOCKET_PATH, PCM_SAMPLE_RATE } from './protocol.ts'
export type {
  ClientMessage,
  LiveSessionId,
  ServerMessage,
  SkipReason,
  UtteranceId,
} from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'live-assist'
/** Required Host services; this optional bundle is valid only above the Web and base bundles. */
export const inject = ['webServer', 'subprocess', 'llm', 'agentDefaultModel', 'sessions']

/**
 * Register the loopback socket route and the recognizer that backs it.
 * @param ctx - the Host plugin context.
 * @param config - Loader-validated composition values.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.effect(() => install(ctx, resolved), 'live-assist: socket route and recognizer')
}
