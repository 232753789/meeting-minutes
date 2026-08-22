/** Projection of the listening-run opener into one chat node carrying the background material. */

import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '../events.ts'

/** Final keyed Chat payload for one listening run's background material. */
export interface BackgroundChatData {
  /** The interviewee's own material, verbatim as every answer request carries it. */
  readonly background: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** The background material one listening run was opened with. */
    'live-assist-background': BackgroundChatData
  }
}

/** Definition kind and chat-node key this projection owns. */
export const BACKGROUND_KIND = 'live-assist-background'

/**
 * Assemble one chat node per listening run.
 *
 * The material is what every answer request in the run carries, so putting it on screen makes
 * the run's inputs readable from the conversation itself rather than only from the log. A run
 * is identified by the opener's own sequence number: stopping and starting again in one session
 * opens a second run, with its own material, and each keeps its own node.
 */
export const backgroundDefinition: ConversationNodeDefinition<BackgroundChatData> = {
  kind: BACKGROUND_KIND,
  target: 'chat',
  match: event => (event.type === 'live-assist/started'
    ? { id: String(event.seq), role: 'start' }
    : null),
  start: (_context, match) => {
    if (match.event.type !== 'live-assist/started') {
      throw new Error('live-assist background start requires live-assist/started')
    }
    return { background: match.event.data.background }
  },
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: BACKGROUND_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
