/** The live socket-and-recognizer installation owned by the plugin fiber. */

import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { LIVE_ASSIST_SOCKET_PATH } from './protocol.ts'
import { LiveAssistSockets } from './ws.ts'
import { LiveAsrWorker } from './worker.ts'

/**
 * Register the socket route, the recognizer, and their teardown.
 * @param ctx - plugin context owning the route registration and the recognizer process.
 * @param config - fully resolved runtime settings.
 * @returns the disposer removing both.
 */
export function install(ctx: Context, config: ResolvedConfig): () => Promise<void> {
  const worker = new LiveAsrWorker(ctx, config)
  const sockets = new LiveAssistSockets(ctx, config, worker)
  const disposeRoute = ctx.webServer.registerUpgrade({
    path: LIVE_ASSIST_SOCKET_PATH,
    handler: sockets.handle,
  })
  return async () => {
    disposeRoute()
    await sockets.dispose()
    await worker.dispose()
  }
}
