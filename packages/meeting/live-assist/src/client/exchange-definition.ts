/** Projection of this plugin's session events into one chat node per question. */

import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '../events.ts'
import type { SkipReason } from '../protocol.ts'

/** Final keyed Chat payload for one counterpart question and its suggested answer. */
export interface ExchangeChatData {
  /** What the counterpart said, as transcribed. */
  readonly question: string
  /** Seconds of speech behind the transcript. */
  readonly seconds: number
  /** Answer text accumulated so far; empty until the first delta. */
  readonly answer: string
  /** `pending` covers the gap between the transcript and the first answer delta. */
  readonly status: 'pending' | 'streaming' | 'done' | 'skipped'
  /** Present only when `status` is `skipped`. */
  readonly reason?: SkipReason
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One counterpart utterance paired with the answer suggested for it. */
    'live-assist-exchange': ExchangeChatData
  }
}

/** Definition kind and chat-node key this projection owns. */
export const EXCHANGE_KIND = 'live-assist-exchange'

/**
 * Assemble one exchange per utterance id.
 *
 * The transcript opens the context and every answer event updates it, so a question is on
 * screen the moment it is recognized and its answer fills in beneath it as tokens arrive.
 */
export const exchangeDefinition: ConversationNodeDefinition<ExchangeChatData> = {
  kind: EXCHANGE_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type === 'live-assist/utterance') return { id: String(event.data.id), role: 'start' }
    if (event.type === 'live-assist/answer-start'
      || event.type === 'live-assist/answer-delta'
      || event.type === 'live-assist/answer-end'
      || event.type === 'live-assist/skipped') {
      return { id: String(event.data.id), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'live-assist/utterance') {
      throw new Error('live-assist exchange start requires live-assist/utterance')
    }
    return {
      question: match.event.data.text,
      seconds: match.event.data.seconds,
      answer: '',
      status: 'pending',
    }
  },
  update: (context, match) => {
    const state = context.state
    if (match.event.type === 'live-assist/answer-start') return { ...state, status: 'streaming' }
    if (match.event.type === 'live-assist/answer-delta') {
      return { ...state, status: 'streaming', answer: state.answer + match.event.data.text }
    }
    if (match.event.type === 'live-assist/answer-end') return { ...state, status: 'done' }
    if (match.event.type === 'live-assist/skipped') {
      return { ...state, status: 'skipped', reason: match.event.data.reason }
    }
    return state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: EXCHANGE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
