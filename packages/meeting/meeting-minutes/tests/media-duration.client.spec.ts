// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaDurationSeconds } from '../src/client/media-duration.ts'

function installProbeCapture(): HTMLAudioElement[] {
  const probes: HTMLAudioElement[] = []
  const NativeAudio = globalThis.Audio
  vi.stubGlobal('Audio', function ProbeAudio(): HTMLAudioElement {
    const element = new NativeAudio()
    probes.push(element)
    return element
  })
  return probes
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('upload duration probe', () => {
  it('reports zero in a browser without object URLs', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new TypeError('createObjectURL is not supported')
    })
    await expect(mediaDurationSeconds(new Blob(['recording']))).resolves.toBe(0)
  })

  it('reports the duration the browser loaded from the file metadata', async () => {
    const probes = installProbeCapture()
    const duration = mediaDurationSeconds(new Blob(['recording']))
    Object.defineProperty(probes[0]!, 'duration', { configurable: true, value: 90.4 })
    probes[0]!.dispatchEvent(new Event('loadedmetadata'))
    await expect(duration).resolves.toBe(90.4)
  })

  it('reports zero when the browser cannot measure the stream', async () => {
    const probes = installProbeCapture()
    const duration = mediaDurationSeconds(new Blob(['recording']))
    probes[0]!.dispatchEvent(new Event('loadedmetadata'))
    await expect(duration).resolves.toBe(0)
  })

  it('reports zero when the file fails to load', async () => {
    const probes = installProbeCapture()
    const duration = mediaDurationSeconds(new Blob(['recording']))
    probes[0]!.dispatchEvent(new Event('error'))
    await expect(duration).resolves.toBe(0)
  })

  it('gives up on a media element that never reports metadata or an error', async () => {
    vi.useFakeTimers()
    const probes = installProbeCapture()
    const duration = mediaDurationSeconds(new Blob(['recording']))
    expect(probes).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    await expect(duration).resolves.toBe(0)
  })
})
