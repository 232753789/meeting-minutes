/** Projection of this plugin's session events into one chat node per question. */

import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '../events.ts'
import type { AnswerTrack, SkipReason } from '../protocol.ts'

/** One answer track's text and how far it has got. */
export interface AnswerTrackState {
  /** Text accumulated so far; empty until the first delta. */
  readonly text: string
  /** `pending` covers the gap before this track's first delta. */
  readonly status: 'pending' | 'streaming' | 'done'
}

/** Final keyed Chat payload for one counterpart question and the answers suggested for it. */
export interface ExchangeChatData {
  /** What the counterpart said, as transcribed. */
  readonly question: string
  /** Seconds of speech behind the transcript. */
  readonly seconds: number
  /** The short answer, opened by the transcript itself. */
  readonly fast: AnswerTrackState
  /** The detailed answer; absent until the Host starts it, and always absent without a deep route. */
  readonly deep?: AnswerTrackState
  /** Present only when the utterance needed no answer at all. */
  readonly skipped?: SkipReason
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One counterpart utterance paired with the answers suggested for it. */
    'live-assist-exchange': ExchangeChatData
  }
}

/** Definition kind and chat-node key this projection owns. */
export const EXCHANGE_KIND = 'live-assist-exchange'

const OPENING: AnswerTrackState = { text: '', status: 'pending' }

function advance(
  state: ExchangeChatData,
  track: AnswerTrack,
  next: (current: AnswerTrackState) => AnswerTrackState,
): ExchangeChatData {
  const current = (track === 'fast' ? state.fast : state.deep) ?? OPENING
  return track === 'fast' ? { ...state, fast: next(current) } : { ...state, deep: next(current) }
}

/**
 * Assemble one exchange per utterance id.
 *
 * The transcript opens the context and every answer event updates the track it names, so a
 * question is on screen the moment it is recognized and each answer fills in beneath it as tokens
 * arrive. Both tracks run the same `pending` to `streaming` to `done` progression; they differ
 * only in what opens them — the transcript for the fast one, the Host's own start for the deep
 * one, which is why a run without a deep route simply never grows a `deep` track.
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
      fast: OPENING,
    }
  },
  update: (context, match) => {
    const state = context.state
    if (match.event.type === 'live-assist/answer-start') {
      return advance(state, match.event.data.track, current => current)
    }
    if (match.event.type === 'live-assist/answer-delta') {
      const { track, text } = match.event.data
      return advance(state, track, current => ({ text: current.text + text, status: 'streaming' }))
    }
    if (match.event.type === 'live-assist/answer-end') {
      return advance(state, match.event.data.track, current => ({ ...current, status: 'done' }))
    }
    if (match.event.type === 'live-assist/skipped') {
      return { ...state, skipped: match.event.data.reason }
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
