/** Browser-side duration probe for a user-selected recording file. */

/** Fixed deadline for one metadata probe; a stalled media element must not block the upload. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Read the playable length of a selected file so its upload keeps meeting-length timestamps.
 *
 * @param file Browser-selected recording.
 * @returns Duration in seconds, or `0` when the browser reports none before the probe deadline.
 */
export async function mediaDurationSeconds(file: Blob): Promise<number> {
  let url: string
  try {
    url = URL.createObjectURL(file)
  } catch {
    // Without object URLs no duration can be probed; the meeting then starts and ends at the file time.
    return 0
  }
  const element = new Audio()
  let timer = 0
  try {
    return await new Promise<number>((resolve) => {
      const finish = (seconds: number): void => { resolve(Number.isFinite(seconds) ? seconds : 0) }
      element.addEventListener('loadedmetadata', () => { finish(element.duration) }, { once: true })
      element.addEventListener('error', () => { finish(0) }, { once: true })
      timer = window.setTimeout(() => { finish(0) }, PROBE_TIMEOUT_MS)
      element.preload = 'metadata'
      element.src = url
    })
  } finally {
    window.clearTimeout(timer)
    URL.revokeObjectURL(url)
  }
}
