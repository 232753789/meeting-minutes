/**
 * Meeting-minutes Host plugin: private recording storage, FFmpeg normalization,
 * local or remote Qwen ASR, Harness-LLM summarization, and loopback HTTP routes.
 * @module @deepseek-ai/dsh-meeting-minutes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Config, resolveConfig } from './config.ts'
import { MEETING_API_PREFIX } from './http.ts'
import { MeetingMinutesInstallation } from './lifecycle.ts'

export { Config, MEETING_API_PREFIX, resolveConfig }
export type { ResolvedConfig } from './config.ts'
export type {
  MeetingAccepted,
  MeetingDeleted,
  MeetingId,
  MeetingList,
  MeetingListEntry,
  MeetingStage,
  MeetingStatus,
  TranscriptSegment,
} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'meeting-minutes'
/** Required Host services; this optional bundle is valid only above the Web and base bundles. */
export const inject = ['webServer', 'subprocess', 'llm', 'agentDefaultModel']

/** Settings namespace whose card edits the storage path and the ASR route. */
export const MEETING_MINUTES_NAMESPACE = settingsNamespace('meeting-minutes')

/**
 * Register the loopback route family, its quiescent processing lifecycle, and the
 * settings section that replaces both when a user edits them.
 */
export function apply(ctx: Context, config: Config): void {
  const installation = new MeetingMinutesInstallation(ctx)
  ctx.effect(() => async () => { await installation.dispose() }, 'meeting-minutes: settings-driven installation')
  installation.apply(resolveConfig(config))
  let source = (): Config => config
  installSettingsSection(ctx, MEETING_MINUTES_NAMESPACE, Config, config, {
    setSource: (next) => { source = next },
    onChange: () => { installation.apply(resolveConfig(source())) },
    // Refuse a write the plugin could not run: the same resolution the Host performs at load,
    // including the complete-local-model check, decides whether the section is installable.
    validate: (value) => { resolveConfig(value) },
  })
}
