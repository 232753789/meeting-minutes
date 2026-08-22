/** WebSocket message types shared by the Host session and the browser panel. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Opaque identifier of one live-assist session, minted by the Host on connect. */
export type LiveSessionId = Branded<'LiveSessionId'>

/**
 * Construct a live-session id after the Host has generated its wire value.
 * @param value - internally generated wire value.
 * @returns the opaque session identifier.
 */
export function LiveSessionId(value: string): LiveSessionId {
  return value as LiveSessionId
}

/** Opaque identifier of one detected utterance within a session. */
export type UtteranceId = Branded<'UtteranceId'>

/**
 * Construct an utterance id from the recognizer's per-session counter.
 * @param value - internally generated wire value.
 * @returns the opaque utterance identifier.
 */
export function UtteranceId(value: string): UtteranceId {
  return value as UtteranceId
}

/** WebSocket path the browser panel connects to. */
export const LIVE_ASSIST_SOCKET_PATH = '/live-assist/socket'

/** Sample rate every PCM frame on this socket must already use. */
export const PCM_SAMPLE_RATE = 16_000

/**
 * Why a detected utterance produced no answer.
 *
 * `not-a-question` is the model's own judgement; `too-short` and `empty-transcript`
 * are the Host's, taken before any model request.
 */
export type SkipReason = 'not-a-question' | 'too-short' | 'empty-transcript'

/** Browser-to-Host control messages; PCM rides the same socket as binary frames. */
export type ClientMessage =
  /**
   * Open the recognizer against an existing dsh session, supplying the interviewee's own
   * background material. The browser creates that session and switches to it first, so every
   * transcript and answer lands in the session the user is already looking at.
   */
  | { readonly type: 'start'; readonly background: string; readonly session: SessionId }
  /** Stop forwarding audio to the recognizer without closing the socket. */
  | { readonly type: 'pause' }
  /** Resume forwarding audio after a pause. */
  | { readonly type: 'resume' }

/**
 * Host-to-browser messages.
 *
 * Transcripts and answers are NOT here: they are appended to the dsh session named at `start`
 * and reach the panel through the ordinary session-event path, so the conversation is their
 * single source and survives a reload.
 */
export type ServerMessage =
  /** The recognizer is open and audio frames are being accepted. */
  | { readonly type: 'ready'; readonly recognizer: LiveSessionId }
  /** The recognizer detected the counterpart starting or stopping speech. */
  | { readonly type: 'speech'; readonly speaking: boolean }
  /** A recoverable failure; the recognizer stays open unless `fatal` is set. */
  | { readonly type: 'error'; readonly message: string; readonly fatal: boolean }
