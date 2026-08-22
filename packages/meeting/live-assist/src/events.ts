/** Session events this plugin contributes, and the ids that correlate them. */

import type {} from '@deepseek-ai/dsh-session'
import type { SkipReason, UtteranceId } from './protocol.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one listening run: the background material every answer request in this session
     * carries. Logged because it reaches the model, so the request is reconstructable from the
     * log; log-only and non-surface, like everything else this plugin appends.
     */
    'live-assist/started': { background: string }
    /**
     * One completed counterpart utterance, as the recognizer transcribed it: log-only,
     * non-surface, and never part of derived model history. `id` correlates it with the
     * `live-assist/answer-*` events that answer it.
     */
    'live-assist/utterance': { id: UtteranceId; text: string; seconds: number }
    /** Answer generation began for `id`; the following deltas carry its text. */
    'live-assist/answer-start': { id: UtteranceId }
    /** One streamed fragment of the answer to `id`, in emission order. */
    'live-assist/answer-delta': { id: UtteranceId; text: string }
    /** Answer generation for `id` finished normally. */
    'live-assist/answer-end': { id: UtteranceId }
    /** The utterance `id` needed no answer, for the stated reason. */
    'live-assist/skipped': { id: UtteranceId; reason: SkipReason }
  }
}
