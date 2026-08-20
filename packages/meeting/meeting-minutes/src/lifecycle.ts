/** The live routes-and-runtime installation, replaced whenever resolved settings change. */

import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import type { ResolvedConfig } from './config.ts'
import { MeetingHttpController, MEETING_API_PREFIX } from './http.ts'
import { MeetingMinutesRuntime } from './runtime.ts'

/**
 * Owns one routes-and-runtime installation and replaces it when settings change.
 *
 * A replacement is a complete teardown and rebuild: the resolved configuration is frozen into the
 * runtime and into the persistent ASR worker, so a meeting still being processed is aborted and
 * recorded as failed exactly as a plugin reload would leave it. Installations are serialized, so a
 * burst of saves lands one at a time and the last one wins.
 */
export class MeetingMinutesInstallation {
  private applied: ResolvedConfig | undefined
  private stop: (() => Promise<void>) | undefined
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  /** @param ctx - plugin context owning the route registration and the processing runtime. */
  constructor(private readonly ctx: Context) {}

  /**
   * Queue an installation of `next`, replacing any earlier one.
   *
   * Settings that resolve to the running configuration install nothing, so re-reading the same
   * document never interrupts a meeting.
   * @param next - fully resolved runtime settings.
   */
  apply(next: ResolvedConfig): void {
    if (this.closed || deepEqualJson(this.applied, next)) return
    this.applied = next
    this.tail = this.tail.then(async () => {
      try {
        await this.install(next)
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Await every queued installation.
   * @returns settlement once no installation is pending.
   */
  settled(): Promise<void> {
    return this.tail
  }

  private async install(next: ResolvedConfig): Promise<void> {
    await this.teardown()
    if (this.closed) return
    const runtime = new MeetingMinutesRuntime(this.ctx, next)
    const http = new MeetingHttpController(runtime)
    this.stop = this.ctx.effect(() => {
      const disposeRoute = this.ctx.webServer.register({
        kind: 'prefix',
        path: MEETING_API_PREFIX,
        handler: http.handle,
      })
      return async () => {
        disposeRoute()
        await http.dispose()
        await runtime.dispose()
      }
    }, 'meeting-minutes: routes and processing runtime')
  }

  private async teardown(): Promise<void> {
    const stop = this.stop
    this.stop = undefined
    if (stop !== undefined) await stop()
  }

  /** Stop replacing and release the current installation. */
  async dispose(): Promise<void> {
    this.closed = true
    await this.tail
    await this.teardown()
  }
}
