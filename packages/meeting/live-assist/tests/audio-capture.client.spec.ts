// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MissingSystemAudioError,
  requestSystemAudioShare,
  startSystemAudioCapture,
} from '../src/client/audio-capture.ts'

interface FakeTrack {
  kind: string
  stop: ReturnType<typeof vi.fn>
  addEventListener: (event: string, listener: () => void) => void
}

function track(kind: string): FakeTrack & { fire: (event: string) => void } {
  const listeners = new Map<string, () => void>()
  return {
    kind,
    stop: vi.fn(),
    addEventListener: (event, listener) => { listeners.set(event, listener) },
    fire: (event) => { listeners.get(event)?.() },
  }
}

function stream(tracks: readonly FakeTrack[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(item => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter(item => item.kind === 'video'),
  } as unknown as MediaStream
}

/** Captures the worklet the code registers, so a test can push frames through it. */
class FakeAudioWorkletNode {
  static last: FakeAudioWorkletNode | undefined
  readonly port = { onmessage: null as ((event: MessageEvent<Int16Array>) => void) | null }
  readonly disconnect = vi.fn()
  readonly connect = vi.fn()

  constructor(readonly context: unknown, readonly processor: string) {
    FakeAudioWorkletNode.last = this
  }
}

function install(options: {
  readonly display?: () => Promise<MediaStream>
  readonly addModule?: () => Promise<void>
} = {}) {
  const addModule = options.addModule ?? (() => Promise.resolve())
  const close = vi.fn(() => Promise.resolve())
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    audioWorklet: { addModule },
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    destination: {},
    close,
  }
  vi.stubGlobal('AudioContext', function FakeAudioContext() { return context })
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', Object.assign(globalThis.URL, {
    createObjectURL: vi.fn(() => 'blob:worklet'),
    revokeObjectURL,
  }))
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: options.display === undefined ? undefined : { getDisplayMedia: options.display },
  })
  return { context, gain, source, close, revokeObjectURL }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeAudioWorkletNode.last = undefined
})

describe('startSystemAudioCapture', () => {
  it('never opens the microphone', async () => {
    const getUserMedia = vi.fn()
    const audio = track('audio')
    const video = track('video')
    install({ display: () => Promise.resolve(stream([audio, video])) })
    Object.assign(navigator.mediaDevices as object, { getUserMedia })

    await startSystemAudioCapture(await requestSystemAudioShare(), { onFrame: () => {}, onEnded: () => {} })
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('requests both audio and video so the share can carry sound', async () => {
    const display = vi.fn(() => Promise.resolve(stream([track('audio'), track('video')])))
    install({ display })
    await requestSystemAudioShare()
    expect(display).toHaveBeenCalledWith({ video: true, audio: true })
  })

  it('forwards worklet frames to the caller', async () => {
    install({ display: () => Promise.resolve(stream([track('audio'), track('video')])) })
    const frames: Int16Array[] = []
    await startSystemAudioCapture(await requestSystemAudioShare(), {
      onFrame: frame => frames.push(frame),
      onEnded: () => {},
    })
    const payload = new Int16Array([1, 2, 3])
    FakeAudioWorkletNode.last?.port.onmessage?.({ data: payload } as MessageEvent<Int16Array>)
    expect(frames).toEqual([payload])
  })

  it('refuses a share that carried no audio and releases it', async () => {
    const audioless = track('video')
    install({ display: () => Promise.resolve(stream([audioless])) })
    await expect(requestSystemAudioShare()).rejects.toBeInstanceOf(MissingSystemAudioError)
    expect(audioless.stop).toHaveBeenCalled()
  })

  it('reports a browser without the capture APIs', async () => {
    install()
    await expect(requestSystemAudioShare()).rejects.toThrow(/cannot capture system audio/)
  })

  it('reports a browser with no AudioWorkletNode', async () => {
    install({ display: () => Promise.resolve(stream([track('audio')])) })
    vi.stubGlobal('AudioWorkletNode', undefined)
    await expect(requestSystemAudioShare()).rejects.toThrow(/cannot capture system audio/)
  })

  it('revokes the worklet URL even when the module fails to load', async () => {
    const { revokeObjectURL } = install({
      display: () => Promise.resolve(stream([track('audio')])),
      addModule: () => Promise.reject(new Error('worklet blocked')),
    })
    const share = await requestSystemAudioShare()
    await expect(startSystemAudioCapture(share, { onFrame: () => {}, onEnded: () => {} }))
      .rejects.toThrow(/worklet blocked/)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:worklet')
  })

  it('stops the share and closes the graph exactly once', async () => {
    const audio = track('audio')
    const video = track('video')
    const { close } = install({ display: () => Promise.resolve(stream([audio, video])) })
    const handle = await startSystemAudioCapture(await requestSystemAudioShare(), {
      onFrame: () => {},
      onEnded: () => {},
    })
    handle.stop()
    handle.stop()
    expect(audio.stop).toHaveBeenCalledTimes(1)
    expect(video.stop).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(FakeAudioWorkletNode.last?.port.onmessage).toBeNull()
  })

  it('reports the user ending the share from the browser banner', async () => {
    const audio = track('audio')
    const video = track('video')
    install({ display: () => Promise.resolve(stream([audio, video])) })
    const onEnded = vi.fn()
    await startSystemAudioCapture(await requestSystemAudioShare(), { onFrame: () => {}, onEnded })
    video.fire('ended')
    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(audio.stop).toHaveBeenCalled()
  })

  it('keeps the counterpart audio out of the speakers', async () => {
    const { gain } = install({ display: () => Promise.resolve(stream([track('audio'), track('video')])) })
    await startSystemAudioCapture(await requestSystemAudioShare(), { onFrame: () => {}, onEnded: () => {} })
    expect(gain.gain.value).toBe(0)
  })
})

describe('requestSystemAudioShare', () => {
  it('opens the picker without building any audio graph', async () => {
    const { context } = install({ display: () => Promise.resolve(stream([track('audio'), track('video')])) })
    const share = await requestSystemAudioShare()
    // The graph is built later, off the click: only the share itself needs the user's gesture.
    expect(share.getAudioTracks()).toHaveLength(1)
    expect(context.createMediaStreamSource).not.toHaveBeenCalled()
  })
})
