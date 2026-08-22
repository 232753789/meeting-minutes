/** System-audio-only PCM capture for the browser panel. */

import { PCM_SAMPLE_RATE } from '../protocol.ts'

/** Samples per posted frame; 100 ms keeps the socket quiet without adding audible latency. */
const FRAME_SAMPLES = PCM_SAMPLE_RATE / 10

/**
 * Worklet source, inlined because the client bundle ships as a single module and
 * `audioWorklet.addModule` needs a fetchable URL of its own.
 */
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Int16Array(${String(FRAME_SAMPLES)})
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel === undefined) return true
    for (let index = 0; index < channel.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, channel[index]))
      this.frame[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      this.filled += 1
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.slice())
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
`

/** A running capture; every handle must be stopped to release the share. */
export interface CaptureHandle {
  /** Stop the worklet, close the audio graph, and end the screen share. */
  stop(): void
}

/** What one capture attempt needs from its caller. */
export interface CaptureOptions {
  /** Receives one little-endian 16-bit mono frame at {@link PCM_SAMPLE_RATE}. */
  readonly onFrame: (frame: Int16Array) => void
  /** Called when the user ends the share from the browser's own banner. */
  readonly onEnded: () => void
}

/** Raised when the share carried no audio track, which is the browser's own switch, not ours. */
export class MissingSystemAudioError extends Error {
  constructor() {
    super('live-assist: the share carried no system audio')
  }
}

/**
 * Ask the user to share a tab, and nothing else.
 *
 * The microphone is never opened: what the counterpart says arrives through the meeting page's
 * playback and lands in this stream, while the interviewee's own voice goes from their microphone
 * straight to the meeting's uplink and never reaches the tab's output. That separation is what
 * keeps the interviewee out of the transcript, so no speaker attribution is needed downstream.
 *
 * This is separate from {@link startSystemAudioCapture} because the browser only opens the share
 * picker while the user's click is still the transient activation. Anything awaited first — a new
 * session, a socket handshake — spends that activation and the picker silently never appears, so
 * this must be called directly from the click handler and its stream carried to the capture.
 * @returns the shared stream, whose audio track is already confirmed present.
 * @throws {MissingSystemAudioError} when the share carried no audio track.
 */
export async function requestSystemAudioShare(): Promise<MediaStream> {
  const mediaDevices = (navigator as unknown as { mediaDevices?: MediaDevices }).mediaDevices
  if (mediaDevices === undefined || typeof AudioWorkletNode === 'undefined') {
    throw new Error('live-assist: this browser cannot capture system audio')
  }
  const display = await mediaDevices.getDisplayMedia({ video: true, audio: true })
  if (display.getAudioTracks().length === 0) {
    for (const track of display.getTracks()) track.stop()
    throw new MissingSystemAudioError()
  }
  return display
}

/**
 * Build the capture graph over an already-shared stream.
 *
 * The shared video track stays live and unused: stopping it would end the share, taking its
 * audio with it.
 * @param display - the stream from {@link requestSystemAudioShare}.
 * @param options - frame sink and share-ended callback.
 * @returns the running capture handle.
 */
export async function startSystemAudioCapture(
  display: MediaStream,
  options: CaptureOptions,
): Promise<CaptureHandle> {
  const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }
  const source = context.createMediaStreamSource(display)
  const node = new AudioWorkletNode(context, 'pcm-capture')
  node.port.onmessage = (event: MessageEvent<Int16Array>) => { options.onFrame(event.data) }
  source.connect(node)
  // A worklet with no downstream sink is not pulled by every implementation; a muted gain node
  // keeps the graph running without routing the counterpart's voice back to the speakers.
  const sink = context.createGain()
  sink.gain.value = 0
  node.connect(sink)
  sink.connect(context.destination)
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    node.port.onmessage = null
    node.disconnect()
    source.disconnect()
    sink.disconnect()
    for (const track of display.getTracks()) track.stop()
    void context.close()
  }
  display.getVideoTracks()[0]?.addEventListener('ended', () => {
    stop()
    options.onEnded()
  })
  return { stop }
}
