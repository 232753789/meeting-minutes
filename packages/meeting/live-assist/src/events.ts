/** Session events this plugin contributes, and the ids that correlate them. */

import type {} from '@deepseek-ai/dsh-session'
import type { AnswerTrack, SkipReason, UtteranceId } from './protocol.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one listening run: the background material every answer request in this session
     * carries. Logged because it reaches the model, so the request is reconstructable from the
     * log; log-only and non-surface, like everything else this plugin appends. The conversation
     * renders it as its own chat node, so the run's inputs are readable there in full.
     */
    'live-assist/started': { background: string }
    /**
     * One completed counterpart utterance, as the recognizer transcribed it: log-only,
     * non-surface, and never part of derived model history. `id` correlates it with the
     * `live-assist/answer-*` events that answer it.
     */
    'live-assist/utterance': { id: UtteranceId; text: string; seconds: number }
    /**
     * Answer generation began for `id` on `track`; the following deltas on that track carry its
     * text. The `deep` track opens on the fast track's own decision to answer, so a `deep` start
     * never appears without the `fast` one before it.
     */
    'live-assist/answer-start': { id: UtteranceId; track: AnswerTrack }
    /** One streamed fragment of `track`'s answer to `id`, in emission order. */
    'live-assist/answer-delta': { id: UtteranceId; track: AnswerTrack; text: string }
    /** Answer generation for `id` finished normally on `track`. */
    'live-assist/answer-end': { id: UtteranceId; track: AnswerTrack }
    /** The utterance `id` needed no answer, for the stated reason. */
    'live-assist/skipped': { id: UtteranceId; reason: SkipReason }
  }
}
