/** Browser panel: composer control, session-event projection, and the exchange renderer. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BACKGROUND_KIND, backgroundDefinition } from './background-definition.ts'
import { BackgroundCard } from './BackgroundCard.tsx'
import { EXCHANGE_KIND, exchangeDefinition } from './exchange-definition.ts'
import { ExchangeCard } from './ExchangeCard.tsx'
import { LiveAssistButton } from './LiveAssistButton.tsx'
import { LiveAssistController } from './live-controller.ts'
import type { LiveAssistControllerInjected } from './contract.ts'
import { en, zh, type LiveAssistKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Panel, capture-hint, status, and exchange copy. */
    'live-assist': LiveAssistKey
  }
}

const NS = 'live-assist'

/** Required slot, locale, projection, and session services. */
export const inject = ['slots', 'locale', 'conversationEvents', 'sessions']

/**
 * Register the composer tool, the exchange projection, and its chat renderer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new LiveAssistController()
  ctx.effect(() => () => { controller.stop() }, 'live-assist: recognizer lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'live-assist: dictionaries')
  ctx.conversationEvents.register(backgroundDefinition)
  ctx.conversationEvents.register(exchangeDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: BACKGROUND_KIND,
    locale: NS,
  }, BackgroundCard))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: EXCHANGE_KIND,
    locale: NS,
  }, ExchangeCard))
  ctx.slots.inject('conversation.input.tool', () => ctx.slots.register({
    name: 'conversation.input.tool',
    id: 'live-assist',
    order: 110,
    locale: NS,
    inject: (): LiveAssistControllerInjected => ({
      controller,
      isBlankSession: session => ctx.sessions.list.getSnapshot().byId[session]?.blank === true,
    }),
  }, LiveAssistButton))
}
