/** The capture-and-socket lifecycle, owned outside React so it survives a session switch. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LIVE_ASSIST_SOCKET_PATH } from '../protocol.ts'
import { startSystemAudioCapture, type CaptureHandle } from './audio-capture.ts'
import { INITIAL_PANEL_STATE, parseServerMessage, reducePanel, type PanelState } from './panel-state.ts'

/** Everything the inline bar renders, plus the failure the panel reports itself. */
export interface ControllerState extends PanelState {
  /** Whether a recognizer is running, including while it is still connecting. */
  readonly running: boolean
  /** Audio is being withheld from the recognizer. */
  readonly paused: boolean
  /** A capture or socket failure raised in the browser, already localized by the caller. */
  readonly failure?: { readonly key: 'share' | 'missingAudio' | 'socket'; readonly message: string }
}

const INITIAL_STATE: ControllerState = { ...INITIAL_PANEL_STATE, running: false, paused: false }

/**
 * Build the same-origin socket URL for the page's own location.
 * @param location - the page location supplying scheme and authority.
 * @returns the ws/wss URL of the Host's live-assist route.
 */
export function socketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${LIVE_ASSIST_SOCKET_PATH}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns one running recognizer across session switches.
 *
 * Listening runs in the session the user started it from, so the interview joins whatever
 * conversation is open rather than opening one of its own. The user is free to switch sessions
 * while it runs, which remounts every session-scoped slot component — so the capture, the socket,
 * and the run state live here instead of in the component.
 */
export class LiveAssistController {
  private readonly listeners = new Set<() => void>()
  private current: ControllerState = INITIAL_STATE
  private capture: CaptureHandle | null = null
  private socket: WebSocket | null = null
  private share: MediaStream | null = null

  /**
   * Subscribe to state changes.
   * @param listener - called after every state transition.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The current state; reference-stable until something changes. */
  getState = (): ControllerState => this.current

  private set(next: ControllerState): void {
    this.current = next
    for (const listener of [...this.listeners]) listener()
  }

  private apply(message: Parameters<typeof reducePanel>[1]): void {
    const reduced = reducePanel(this.current, message)
    if (reduced === this.current) return
    this.set({ ...this.current, ...reduced })
  }

  /**
   * Open the recognizer over an already-shared stream, against the session the user is in.
   *
   * The share must already be open: the browser grants it only while the user's click is the
   * transient activation, which anything awaited before this call would spend.
   * @param background - the interviewee's own material.
   * @param session - the session that will carry the transcript and answers.
   * @param share - the stream from `requestSystemAudioShare`.
   */
  start(background: string, session: SessionId, share: MediaStream): void {
    if (this.current.running) return
    this.share = share
    const { failure: _cleared, ...rest } = this.current
    this.set({ ...rest, running: true, connected: false, paused: false })
    void this.run(background, session, share)
  }

  private async run(background: string, session: SessionId, share: MediaStream): Promise<void> {
    let live: WebSocket
    try {
      live = new WebSocket(socketUrl(window.location))
    } catch (error) {
      for (const track of share.getTracks()) track.stop()
      this.fail('socket', errorMessage(error))
      return
    }
    this.socket = live
    live.binaryType = 'arraybuffer'
    live.addEventListener('message', (event: MessageEvent<string>) => {
      const message = parseServerMessage(event.data)
      if (message !== undefined) this.apply(message)
    })
    live.addEventListener('close', () => {
      if (this.socket !== live) return
      this.stop()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        live.addEventListener('open', () => { resolve() }, { once: true })
        live.addEventListener('error', () => { reject(new Error('socket error')) }, { once: true })
      })
      live.send(JSON.stringify({ type: 'start', background, session }))
      this.capture = await startSystemAudioCapture(share, {
        onFrame: (frame) => {
          if (live.readyState === WebSocket.OPEN) live.send(frame.buffer as ArrayBuffer)
        },
        onEnded: () => { this.stop() },
      })
    } catch (error) {
      for (const track of share.getTracks()) track.stop()
      this.release()
      this.fail('share', errorMessage(error))
    }
  }

  private fail(key: 'share' | 'missingAudio' | 'socket', message: string): void {
    this.set({ ...INITIAL_STATE, failure: { key, message } })
  }

  private release(): void {
    this.capture?.stop()
    this.capture = null
    const live = this.socket
    this.socket = null
    if (live !== null && live.readyState <= WebSocket.OPEN) live.close(1000, 'panel stopped')
  }

  /** Stop the recognizer and release the share. */
  stop = (): void => {
    // A start whose socket never opened still holds the share the picker granted.
    const share = this.share
    this.share = null
    if (share !== null) for (const track of share.getTracks()) track.stop()
    this.release()
    this.set({ ...INITIAL_STATE, ...(this.current.failure === undefined ? {} : { failure: this.current.failure }) })
  }

  /** Withhold or resume audio without dropping the recognizer. */
  togglePause = (): void => {
    const live = this.socket
    if (live === null || live.readyState !== WebSocket.OPEN) return
    const next = !this.current.paused
    live.send(JSON.stringify({ type: next ? 'pause' : 'resume' }))
    this.set({ ...this.current, paused: next })
  }
}
