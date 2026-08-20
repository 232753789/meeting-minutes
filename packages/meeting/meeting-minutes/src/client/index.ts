/** Browser recorder, result dialog, and the plugin's own settings card. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the settings shell's `ctx.settingsScope` Context merge and the plugin
// configuration page's `settings.plugin.item` SlotMap entry. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { MeetingMinutesButton } from './MeetingMinutesButton.tsx'
import { MeetingMinutesSettingsCard } from './MeetingMinutesSettingsCard.tsx'
import { MEETING_MINUTES_NS, MeetingSettingsForm } from './settings-form.ts'
import { en, zh, type MeetingMinutesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Recorder, processing progress, result, and settings-card copy. */
    'meeting-minutes': MeetingMinutesKey
  }
}

const NS = 'meeting-minutes'

/** Required slot and locale services. */
export const inject = ['slots', 'locale']

/**
 * Register the composer recorder, and the settings card wherever the settings surface is mounted.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meeting-minutes: dictionaries')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'meeting-minutes',
    order: 100,
    locale: NS,
  }, MeetingMinutesButton))

  // The recorder is the plugin's product surface and must not depend on the settings page, so
  // the card rides a scoped fiber: a deployment without the settings shell simply has no card.
  ctx.inject(['settingsScope', 'connection', 'remote'], (settingsCtx) => {
    const form = new MeetingSettingsForm(
      settingsCtx.settingsScope.bind({ namespace: MEETING_MINUTES_NS }),
    )
    const store = form.bind()
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      key: MEETING_MINUTES_NS,
      locale: NS,
      inject: () => ({ hooks: { meetingSettingsCard: store }, ...form.actions() }),
    }, MeetingMinutesSettingsCard))
  })
}
