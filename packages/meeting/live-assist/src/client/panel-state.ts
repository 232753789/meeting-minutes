/** Pure reduction of the socket's live status into what the inline bar renders. */

import type { ServerMessage } from '../protocol.ts'

/** Live status of one running recognizer; transcripts and answers live in the conversation. */
export interface PanelState {
  /** The recognizer accepted the session and is consuming audio. */
  readonly connected: boolean
  /** The counterpart is speaking right now. */
  readonly speaking: boolean
  /** Latest failure reported by the Host, retained until the next `ready`. */
  readonly error?: string
}

/** The state of a panel that has not connected yet. */
export const INITIAL_PANEL_STATE: PanelState = {
  connected: false,
  speaking: false,
}

/**
 * Apply one Host status message.
 * @param state - current panel state.
 * @param message - the message just received.
 * @returns the next state; the same object when nothing changed.
 */
export function reducePanel(state: PanelState, message: ServerMessage): PanelState {
  switch (message.type) {
    case 'ready': {
      const { error: _cleared, ...rest } = state
      return { ...rest, connected: true }
    }
    case 'speech':
      return { ...state, speaking: message.speaking }
    case 'error':
      return { ...state, error: message.message, ...(message.fatal ? { connected: false } : {}) }
    default:
      return state
  }
}

/**
 * Decode one Host message from the socket.
 * @param raw - the socket's text payload.
 * @returns the decoded message, or undefined when it is not one the panel understands.
 */
export function parseServerMessage(raw: string): ServerMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const value = parsed as Record<string, unknown>
  return typeof value.type === 'string' ? (value as unknown as ServerMessage) : undefined
}
