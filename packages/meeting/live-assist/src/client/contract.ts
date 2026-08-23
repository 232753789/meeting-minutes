/** What the composer slot injects into the live-assist control. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LiveAssistController } from './live-controller.ts'

/** Injected share for the composer control. */
export interface LiveAssistControllerInjected {
  /** The run lifecycle, owned outside React so it survives a session switch. */
  readonly controller: LiveAssistController
  /**
   * Whether a session's log is still empty.
   *
   * Nothing this plugin appends opens a turn, so an interview recorded in a blank session leaves
   * it blank: the list shows it only while it is selected, and the next New Session reuses it.
   * The setup dialog warns before that happens rather than silently producing a session the user
   * cannot find afterwards.
   * @param session - the session the control is mounted in.
   * @returns true when that session's log is still empty.
   */
  readonly isBlankSession: (session: SessionId) => boolean
}
