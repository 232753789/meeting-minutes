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
 * Starting one from a session that already holds a conversation creates a new dsh session, which
 * remounts every session-scoped slot component — so the capture, the socket, and the run state
 * live here instead of in the component. A start is therefore a two-step handoff: the composer of
 * the old session records the request, and the component that mounts in the newly created session
 * adopts it with that session's id. Starting from a blank session skips the switch and adopts
 * that session directly.
 */
export class LiveAssistController {
  private readonly listeners = new Set<() => void>()
  private current: ControllerState = INITIAL_STATE
  private capture: CaptureHandle | null = null
  private socket: WebSocket | null = null
  private pending: {
    readonly background: string
    readonly from: SessionId | undefined
    readonly share: MediaStream
  } | null = null

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
   * Record a start request over an already-shared stream; the caller then supplies the session
   * that will adopt it.
   *
   * The share must already be open: the browser grants it only while the user's click is the
   * transient activation, which the session creation that follows would spend.
   * @param background - the interviewee's own material.
   * @param from - the session that must not adopt this request, because the caller is switching
   * away from it; `undefined` when the caller is listening in place and the very next `adopt`
   * is the intended one.
   * @param share - the stream from `requestSystemAudioShare`.
   */
  request(background: string, from: SessionId | undefined, share: MediaStream): void {
    this.pending = { background, from, share }
    const { failure: _cleared, ...rest } = this.current
    this.set({ ...rest, running: true, connected: false, paused: false })
  }

  /** Whether a start request is waiting for its session. */
  get awaiting(): boolean {
    return this.pending !== null
  }

  /**
   * Adopt a waiting start request into `session`, unless this is the session it came from.
   *
   * A request recorded with no `from` is adopted by whichever session offers itself first, which
   * is how listening in a blank session works: no switch happens, so no other mount ever would.
   * @param session - the session that will carry the transcript and answers.
   */
  adopt(session: SessionId): void {
    const pending = this.pending
    if (pending === null || pending.from === session) return
    this.pending = null
    void this.run(pending.background, session, pending.share)
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
    const pending = this.pending
    this.pending = null
    // A request that never found its session still holds an open share.
    if (pending !== null) for (const track of pending.share.getTracks()) track.stop()
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
