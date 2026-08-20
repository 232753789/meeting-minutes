// @vitest-environment jsdom
// Assembled meeting-minutes snapshot: mounts the optional package's real built
// client bundle through AppWebEntry, records through MediaRecorder, and pins the
// history list, completed and retry result dialogs, and one file upload over the
// package's HTTP contract.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  installAssembledBootEnv,
  mountAssembledApp,
  REFRESHING_GOLDEN,
  type AssembledBootPlugin,
} from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/meeting-minutes/result.expected.txt')
const RETRY_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/meeting-minutes/retry.expected.txt')
const HISTORY_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/meeting-minutes/history.expected.txt')
const UPLOAD_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/meeting-minutes/upload.expected.txt')
const MEETING_ID = 'meeting-20260819T091500-012345abcdef'
const UPLOADED_ID = 'meeting-20260819T020000-abcdef012345'
const EMPTY_HISTORY = { meetings: [] }
const HISTORY = {
  meetings: [
    {
      id: MEETING_ID,
      stage: 'complete',
      name: '2026-08-19_09-15_Project-weekly-sync_5m.md',
      createdAt: '2026-08-19T01:21:00.000Z',
    },
    {
      id: UPLOADED_ID,
      stage: 'failed',
      name: 'morning-standup.mp4',
      createdAt: '2026-08-19T02:00:10.000Z',
    },
    {
      id: 'meeting-20260820T010000-0123456789ab',
      stage: 'transcribing',
      name: 'original.mp4',
      createdAt: '2026-08-20T01:00:00.000Z',
    },
  ],
}

function writeGolden(file: string, shape: string): void {
  if (!REFRESHING_GOLDEN) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, shape)
}
const MEETING_PLUGIN: AssembledBootPlugin = {
  id: '@deepseek-ai/dsh-meeting-minutes',
  bundlePath: 'packages/meeting/meeting-minutes/lib/client.js',
  url: '/plugins/meeting-minutes.js',
  rev: 'fx',
  inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation'],
}

class MediaRecorderFixture {
  static isTypeSupported(type: string): boolean {
    return type.startsWith('audio/webm')
  }

  readonly mimeType: string
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['recording'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.()
  }
}

installAssembledBootEnv()

describe('assembled meeting-minutes result', () => {
  it('renders normalized audio, topic, summary, transcript, and both downloads', async () => {
    vi.stubGlobal('MediaRecorder', MediaRecorderFixture)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    })
    const fetchFixture = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(EMPTY_HISTORY), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: MEETING_ID,
        statusUrl: `/meeting-minutes/api/meetings/${MEETING_ID}`,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: MEETING_ID,
        stage: 'complete',
        startedAt: '2026-08-19T01:15:00.000Z',
        endedAt: '2026-08-19T01:20:00.000Z',
        updatedAt: '2026-08-19T01:21:00.000Z',
        completedChunks: 1,
        totalChunks: 1,
        audioReady: true,
        topic: 'Project weekly sync',
        transcript: 'Complete meeting transcript.',
        summaryMarkdown: '### Decisions\n\nContinue the agreed rollout.',
        minutesFilename: '2026-08-19_09-15_Project-weekly-sync_5m.md',
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchFixture)

    mountAssembledApp([MEETING_PLUGIN])
    fireEvent.click(await screen.findByRole('button', { name: 'Meeting minutes' }, { timeout: 10_000 }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('No recordings yet')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start recording' }))
    await within(dialog).findByText(/Recording ·/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop and submit' }))
    await within(dialog).findByText('Meeting minutes are ready')
    await waitFor(() => { expect(fetchFixture).toHaveBeenCalledTimes(3) })

    const download = within(dialog).getByRole('link', { name: 'Download Markdown' })
    const transcriptFile = within(dialog).getByRole('link', { name: 'Download transcript text' })
    const original = within(dialog).getByRole('link', { name: 'Download original audio' })
    const audio = dialog.querySelector('audio')
    const transcript = within(dialog).getByText('Complete meeting transcript.')
    const shape = [
      `title=${within(dialog).getByRole('heading', { name: 'Meeting minutes' }).textContent}`,
      'state=Meeting minutes are ready',
      `topic=${within(dialog).getByText('Project weekly sync').textContent}`,
      `audio=${audio?.getAttribute('src') ?? '<absent>'}`,
      `summary=${within(dialog).getByText(/Continue the agreed rollout/).textContent}`,
      `transcript=${transcript.textContent}`,
      `download=${download.getAttribute('href') ?? '<absent>'}`,
      `transcriptFile=${transcriptFile.getAttribute('href') ?? '<absent>'}`,
      `original=${original.getAttribute('href') ?? '<absent>'}`,
    ].join('\n') + '\n'
    writeGolden(EXPECTED, shape)
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })

  it('renders a failed meeting and completes another processing attempt from the original', async () => {
    vi.stubGlobal('MediaRecorder', MediaRecorderFixture)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    })
    const baseStatus = {
      id: MEETING_ID,
      startedAt: '2026-08-19T01:15:00.000Z',
      endedAt: '2026-08-19T01:20:00.000Z',
      updatedAt: '2026-08-19T01:21:00.000Z',
      totalChunks: 1,
      audioReady: true,
    }
    const fetchFixture = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(EMPTY_HISTORY), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: MEETING_ID,
        statusUrl: `/meeting-minutes/api/meetings/${MEETING_ID}`,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...baseStatus,
        stage: 'failed',
        completedChunks: 0,
        error: 'ASR model unavailable',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: MEETING_ID,
        statusUrl: `/meeting-minutes/api/meetings/${MEETING_ID}`,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...baseStatus,
        stage: 'complete',
        completedChunks: 1,
        topic: 'Recovered weekly sync',
        transcript: 'Recovered complete transcript.',
        summaryMarkdown: '### Decisions\n\nContinue after recovery.',
        minutesFilename: '2026-08-19_09-15_Recovered-weekly-sync_5m.md',
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchFixture)

    mountAssembledApp([MEETING_PLUGIN])
    fireEvent.click(await screen.findByRole('button', { name: 'Meeting minutes' }, { timeout: 10_000 }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('No recordings yet')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start recording' }))
    await within(dialog).findByText(/Recording ·/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop and submit' }))
    await within(dialog).findByText('Processing failed')

    const before = [
      'before.state=Processing failed',
      `before.error=${within(dialog).getByText('ASR model unavailable').textContent}`,
      `before.retry=${within(dialog).getByRole('button', { name: 'Process again' }).textContent}`,
      `before.back=${within(dialog).getByRole('button', { name: 'Back to list' }).textContent}`,
      `before.original=${within(dialog).getByRole('link', { name: 'Download original audio' }).getAttribute('href') ?? '<absent>'}`,
    ]
    fireEvent.click(within(dialog).getByRole('button', { name: 'Process again' }))
    await within(dialog).findByText('Meeting minutes are ready')
    await waitFor(() => { expect(fetchFixture).toHaveBeenCalledTimes(5) })
    const retryRequest = fetchFixture.mock.calls[3]
    const after = [
      `retry=${String((retryRequest?.[1] as RequestInit).method)} ${String(retryRequest?.[0])}`,
      'after.state=Meeting minutes are ready',
      `after.topic=${within(dialog).getByText('Recovered weekly sync').textContent}`,
      `after.transcript=${within(dialog).getByText('Recovered complete transcript.').textContent}`,
      `after.minutes=${within(dialog).getByRole('link', { name: 'Download Markdown' }).getAttribute('href') ?? '<absent>'}`,
      `after.original=${within(dialog).getByRole('link', { name: 'Download original audio' }).getAttribute('href') ?? '<absent>'}`,
    ]
    const shape = [...before, ...after].join('\n') + '\n'
    writeGolden(RETRY_EXPECTED, shape)
    await expect(shape).toMatchFileSnapshot(RETRY_EXPECTED)
  })

  it('opens a stored meeting from the history list', async () => {
    const fetchFixture = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(HISTORY), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: MEETING_ID,
        stage: 'complete',
        startedAt: '2026-08-19T01:15:00.000Z',
        endedAt: '2026-08-19T01:20:00.000Z',
        updatedAt: '2026-08-19T01:21:00.000Z',
        completedChunks: 1,
        totalChunks: 1,
        audioReady: true,
        topic: 'Project weekly sync',
        transcript: 'Complete meeting transcript.',
        summaryMarkdown: '### Decisions\n\nContinue the agreed rollout.',
        minutesFilename: '2026-08-19_09-15_Project-weekly-sync_5m.md',
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchFixture)

    mountAssembledApp([MEETING_PLUGIN])
    fireEvent.click(await screen.findByRole('button', { name: 'Meeting minutes' }, { timeout: 10_000 }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('2026-08-19_09-15_Project-weekly-sync_5m.md')
    const rows = Array.from(dialog.querySelectorAll('time')).map(time => time.closest('button'))
    const listed = rows.map(row => [
      row?.querySelector('span:last-of-type')?.textContent ?? '<absent>',
      row?.querySelector('time')?.getAttribute('datetime') ?? '<absent>',
    ].join(' @ '))
    const columns = [
      within(dialog).getByText('Name').textContent ?? '<absent>',
      within(dialog).getByText('Created').textContent ?? '<absent>',
    ].join('/')
    const removals = within(dialog).getAllByRole('button', { name: /^Delete / })
      .map(button => button.hasAttribute('disabled') ? 'disabled' : 'enabled')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete morning-standup.mp4' }))
    const confirmation = [
      within(dialog).getByRole('button', { name: 'Confirm delete' }).textContent ?? '<absent>',
      within(dialog).getByRole('button', { name: 'Cancel' }).textContent ?? '<absent>',
    ].join('/')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(rows[0]!)
    await within(dialog).findByText('Meeting minutes are ready')

    const shape = [
      `columns=${columns}`,
      ...listed.map((row, index) => `row.${String(index)}=${row}`),
      ...removals.map((state, index) => `row.${String(index)}.delete=${state}`),
      `confirmation=${confirmation}`,
      `opened.status=${String(fetchFixture.mock.calls[1]?.[0])}`,
      `opened.topic=${within(dialog).getByText('Project weekly sync').textContent}`,
      `opened.minutes=${within(dialog).getByRole('link', { name: 'Download Markdown' }).getAttribute('href') ?? '<absent>'}`,
      `opened.transcript=${within(dialog).getByRole('link', { name: 'Download transcript text' }).getAttribute('href') ?? '<absent>'}`,
      `opened.reprocess=${within(dialog).getByRole('button', { name: 'Process again' }).textContent}`,
    ].join('\n') + '\n'
    writeGolden(HISTORY_EXPECTED, shape)
    await expect(shape).toMatchFileSnapshot(HISTORY_EXPECTED)
  })

  it('uploads a chosen recording with timestamps derived from its duration', async () => {
    const probes: HTMLAudioElement[] = []
    const NativeAudio = globalThis.Audio
    vi.stubGlobal('Audio', function ProbeAudio(): HTMLAudioElement {
      const element = new NativeAudio()
      probes.push(element)
      return element
    })
    const fetchFixture = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(EMPTY_HISTORY), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: UPLOADED_ID,
        statusUrl: `/meeting-minutes/api/meetings/${UPLOADED_ID}`,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: UPLOADED_ID,
        stage: 'complete',
        startedAt: '2026-08-19T01:58:30.000Z',
        endedAt: '2026-08-19T02:00:00.000Z',
        updatedAt: '2026-08-19T02:01:00.000Z',
        completedChunks: 1,
        totalChunks: 1,
        audioReady: true,
        topic: 'Morning standup',
        transcript: 'Uploaded meeting transcript.',
        summaryMarkdown: '### Decisions\n\nShip the queued fixes.',
        minutesFilename: '2026-08-19_09-58_Morning-standup_2m.md',
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchFixture)

    mountAssembledApp([MEETING_PLUGIN])
    fireEvent.click(await screen.findByRole('button', { name: 'Meeting minutes' }, { timeout: 10_000 }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('No recordings yet')
    fireEvent.change(within(dialog).getByLabelText('Upload recording'), {
      target: {
        files: [new File(['recording'], 'morning-standup.mp4', {
          type: 'video/mp4',
          lastModified: Date.parse('2026-08-19T02:00:00.000Z'),
        })],
      },
    })
    await waitFor(() => { expect(probes.length).toBeGreaterThan(0) })
    Object.defineProperty(probes[0]!, 'duration', { configurable: true, value: 90 })
    probes[0]!.dispatchEvent(new Event('loadedmetadata'))
    await within(dialog).findByText('Meeting minutes are ready')

    const upload = fetchFixture.mock.calls[1]?.[1] as RequestInit
    const headers = upload.headers as Record<string, string>
    const shape = [
      `upload=${String((upload).method)} ${String(fetchFixture.mock.calls[1]?.[0])}`,
      `upload.type=${headers['content-type'] ?? '<absent>'}`,
      `upload.started=${headers['x-meeting-started-at'] ?? '<absent>'}`,
      `upload.ended=${headers['x-meeting-ended-at'] ?? '<absent>'}`,
      `upload.source=${decodeURIComponent(headers['x-meeting-source-filename'] ?? '')}`,
      'state=Meeting minutes are ready',
      `source=${within(dialog).getByText('morning-standup.mp4').textContent}`,
      `topic=${within(dialog).getByText('Morning standup').textContent}`,
      `minutes=${within(dialog).getByRole('link', { name: 'Download Markdown' }).getAttribute('href') ?? '<absent>'}`,
    ].join('\n') + '\n'
    writeGolden(UPLOAD_EXPECTED, shape)
    await expect(shape).toMatchFileSnapshot(UPLOAD_EXPECTED)
  })
})
