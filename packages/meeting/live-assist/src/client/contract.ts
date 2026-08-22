/** What the composer slot injects into the live-assist control. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LiveAssistController } from './live-controller.ts'

/** Injected share for the composer control. */
export interface LiveAssistControllerInjected {
  /** The run lifecycle shared across session switches. */
  readonly controller: LiveAssistController
  /** Create a new dsh session and make it current; the new mount adopts the pending start. */
  readonly startSession: () => void
  /**
   * Whether a session has an empty log, and is therefore the session a New Session flow would
   * land in anyway.
   *
   * Starting from one must listen in place: `startSession` reuses the workspace's blank session,
   * so requesting a switch out of the blank session the user is already in returns that same id,
   * no remount follows, and a start that waits for a different session would wait forever.
   * @param session - the session the control is mounted in.
   * @returns true when that session's log is still empty.
   */
  readonly isBlankSession: (session: SessionId) => boolean
}
