// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingMinutesButton } from '../src/client/MeetingMinutesButton.tsx'
import { zh } from '../src/client/locales.ts'

const probe = vi.hoisted(() => ({ seconds: 0 }))
vi.mock('../src/client/media-duration.ts', () => ({
  mediaDurationSeconds: () => Promise.resolve(probe.seconds),
}))

const API = '/meeting-minutes/api/meetings'
const MEETING_ID = 'meeting-20260819T091500-012345abcdef'
const UPLOADED_ID = 'meeting-20260819T020000-abcdef012345'

class FakeMediaRecorder {
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

const stopTrack = vi.fn()
const stopDisplayTrack = vi.fn()

const DEVICES = [
  { deviceId: 'mic-usb', kind: 'audioinput', label: '外接麦克风' },
  { deviceId: 'speaker', kind: 'audiooutput', label: '扬声器' },
] as unknown as MediaDeviceInfo[]

/** One shared-screen stream; `withAudio` mirrors the picker's system-audio switch. */
function fakeDisplayStream(withAudio: boolean): MediaStream {
  const audio = withAudio ? [{ stop: stopDisplayTrack }] : []
  const video = [{ stop: stopDisplayTrack, addEventListener: vi.fn() }]
  return {
    getAudioTracks: () => audio,
    getVideoTracks: () => video,
    getTracks: () => [...audio, ...video],
  } as unknown as MediaStream
}

/** Records how many sources were summed into the single recorded track. */
class FakeAudioContext {
  static last: FakeAudioContext | null = null
  readonly sources: MediaStream[] = []
  closed = false

  constructor() {
    FakeAudioContext.last = this
  }

  createMediaStreamDestination(): { stream: MediaStream } {
    return { stream: { getTracks: () => [] } as unknown as MediaStream }
  }

  createMediaStreamSource(stream: MediaStream): { connect: () => void } {
    this.sources.push(stream)
    return { connect: () => {} }
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

function props(): ComponentProps<typeof MeetingMinutesButton> {
  const t = (key: keyof typeof zh, params?: Record<string, unknown>): string => {
    let text: string = zh[key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  }
  return { t } as unknown as ComponentProps<typeof MeetingMinutesButton>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

const HISTORY = {
  meetings: [
    {
      id: MEETING_ID,
      stage: 'complete',
      name: '2026-08-19_09-15_项目周会_5m.md',
      createdAt: '2026-08-19T01:21:00.000Z',
    },
    { id: UPLOADED_ID, stage: 'failed', name: '晨会录音.mp4', createdAt: '2026-08-19T00:10:00.000Z' },
  ],
}

const COMPLETE = {
  id: MEETING_ID,
  stage: 'complete',
  startedAt: '2026-08-19T01:15:00.000Z',
  endedAt: '2026-08-19T01:20:00.000Z',
  updatedAt: '2026-08-19T01:21:00.000Z',
  completedChunks: 1,
  totalChunks: 1,
  audioReady: true,
  topic: '项目周会',
  transcript: '完整转写',
  summaryMarkdown: '### 决策\n继续推进',
  minutesFilename: '2026-08-19_09-15_项目周会_5m.md',
}

describe('meeting-minutes browser recorder', () => {
  beforeEach(() => {
    probe.seconds = 0
    window.localStorage.clear()
    stopTrack.mockReset()
    stopDisplayTrack.mockReset()
    FakeAudioContext.last = null
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
        getDisplayMedia: vi.fn(async () => fakeDisplayStream(true)),
        enumerateDevices: vi.fn(async () => DEVICES),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('records, uploads, polls, plays normalized audio, and exposes every download', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ meetings: [] }))
      .mockResolvedValueOnce(json({ id: MEETING_ID, statusUrl: `/status/${MEETING_ID}` }, 202))
      .mockResolvedValueOnce(json(COMPLETE))
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }))
    await screen.findByText(/正在录音/)
    fireEvent.click(screen.getByRole('button', { name: '结束并提交' }))

    await screen.findByText('会议纪要已完成')
    expect(screen.getByText('项目周会')).toBeTruthy()
    expect(screen.getByText('完整转写')).toBeTruthy()
    expect(screen.getByRole('link', { name: '下载 Markdown' }).getAttribute('href')).toBe(`${API}/${MEETING_ID}/minutes`)
    expect(screen.getByRole('link', { name: '下载转写原文' }).getAttribute('href'))
      .toBe(`${API}/${MEETING_ID}/transcript`)
    expect(screen.getByRole('link', { name: '下载原始音频' }).getAttribute('href'))
      .toBe(`${API}/${MEETING_ID}/original`)
    expect(document.querySelector('audio')?.getAttribute('src')).toBe(`${API}/${MEETING_ID}/audio`)
    expect(stopTrack).toHaveBeenCalledOnce()
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(3) })
    const upload = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(upload.method).toBe('POST')
    expect(upload.body).toBeInstanceOf(Blob)
  })

  it('mixes the shared system audio into the recording when that option is enabled', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ meetings: [] }))
      .mockResolvedValueOnce(json({ id: MEETING_ID, statusUrl: `/status/${MEETING_ID}` }, 202))
      .mockResolvedValueOnce(json(COMPLETE))
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    fireEvent.click(screen.getByLabelText('同时录制电脑内放'))
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }))
    await screen.findByText(/正在录音/)

    const mediaDevices = navigator.mediaDevices as unknown as { getDisplayMedia: ReturnType<typeof vi.fn> }
    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true })
    expect(FakeAudioContext.last?.sources).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '结束并提交' }))
    await screen.findByText('会议纪要已完成')
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(stopDisplayTrack).toHaveBeenCalledTimes(2)
    expect(FakeAudioContext.last?.closed).toBe(true)
  })

  it('refuses a share that carries no system audio instead of recording the microphone alone', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ meetings: [] }))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
        getDisplayMedia: vi.fn(async () => fakeDisplayStream(false)),
      },
    })
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    fireEvent.click(screen.getByLabelText('同时录制电脑内放'))
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }))

    await screen.findByText(/本次共享未包含系统音频/)
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(stopDisplayTrack).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('names microphones once access is granted and records the selected device', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ meetings: [] }))
      .mockResolvedValueOnce(json({ id: MEETING_ID, statusUrl: `/status/${MEETING_ID}` }, 202))
      .mockResolvedValueOnce(json(COMPLETE))
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    const select = screen.getByLabelText('麦克风')
    expect(screen.queryByRole('option', { name: '外接麦克风' })).toBeNull()

    fireEvent.focus(select)
    await screen.findByRole('option', { name: '外接麦克风' })
    expect(screen.queryByRole('option', { name: '扬声器' })).toBeNull()
    fireEvent.change(select, { target: { value: 'mic-usb' } })
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }))
    await screen.findByText(/正在录音/)

    const mediaDevices = navigator.mediaDevices as unknown as { getUserMedia: ReturnType<typeof vi.fn> }
    expect(mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: 'mic-usb' },
    })
    expect(JSON.parse(window.localStorage.getItem('dsh.meeting-minutes.capture') ?? 'null'))
      .toEqual({ microphone: 'mic-usb', systemAudio: false })
  })

  it('records computer audio alone when no microphone is selected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ meetings: [] }))
      .mockResolvedValueOnce(json({ id: MEETING_ID, statusUrl: `/status/${MEETING_ID}` }, 202))
      .mockResolvedValueOnce(json(COMPLETE))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    fireEvent.change(screen.getByLabelText('麦克风'), { target: { value: 'none' } })
    expect(screen.getByRole('button', { name: '开始录音' }).hasAttribute('disabled')).toBe(true)
    await screen.findByText('请至少选择麦克风或电脑内放。')

    fireEvent.click(screen.getByLabelText('同时录制电脑内放'))
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }))
    await screen.findByText(/正在录音/)

    const mediaDevices = navigator.mediaDevices as unknown as { getUserMedia: ReturnType<typeof vi.fn> }
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(FakeAudioContext.last?.sources).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '结束并提交' }))
    await screen.findByText('会议纪要已完成')
    view.unmount()

    render(<MeetingMinutesButton {...props()} />)
    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    expect(screen.getByLabelText<HTMLSelectElement>('麦克风').value).toBe('none')
    expect(screen.getByLabelText<HTMLInputElement>('同时录制电脑内放').checked).toBe(true)
  })

  it('reprocesses a failed meeting from its preserved original recording', async () => {
    const baseStatus = {
      id: MEETING_ID,
      startedAt: '2026-08-19T01:15:00.000Z',
      endedAt: '2026-08-19T01:20:00.000Z',
      updatedAt: '2026-08-19T01:21:00.000Z',
      totalChunks: 1,
      audioReady: true,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ meetings: [] }))
      .mockResolvedValueOnce(json({ id: MEETING_ID, statusUrl: `/status/${MEETING_ID}` }, 202))
      .mockResolvedValueOnce(json({ ...baseStatus, stage: 'failed', completedChunks: 0, error: 'ASR unavailable' }))
      .mockResolvedValueOnce(json({ id: MEETING_ID, statusUrl: `/status/${MEETING_ID}` }, 202))
      .mockResolvedValueOnce(json({
        ...baseStatus,
        stage: 'complete',
        completedChunks: 1,
        topic: '重试会议',
        transcript: '重试后的完整转写',
        summaryMarkdown: '### 结论\n重试完成',
        minutesFilename: 'minutes.md',
      }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }))
    await screen.findByText(/正在录音/)
    fireEvent.click(screen.getByRole('button', { name: '结束并提交' }))

    await screen.findByText('处理失败')
    expect(screen.getByText('ASR unavailable')).toBeTruthy()
    expect(screen.getByRole('link', { name: '下载原始音频' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新解析' }))

    await screen.findByText('会议纪要已完成')
    expect(screen.getByText('重试会议')).toBeTruthy()
    expect(screen.getByText('重试后的完整转写')).toBeTruthy()
    const retry = fetchMock.mock.calls[3]
    expect(retry?.[0]).toBe(`${API}/${MEETING_ID}/retry`)
    expect((retry?.[1] as RequestInit).method).toBe('POST')
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(5) })
  })

  it('does not offer processing retry when recording failed before upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ meetings: [] })))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new Error('permission denied') }) },
    })
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }))
    await screen.findByText('处理失败')
    expect(screen.queryByRole('button', { name: '重新解析' })).toBeNull()
    expect(screen.queryByRole('link', { name: '下载原始音频' })).toBeNull()
    expect(screen.getByRole('button', { name: '重新录音' })).toBeTruthy()
  })

  it('opens a stored meeting from the history list and returns to a refreshed list', async () => {
    let status: unknown = COMPLETE
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === API && init?.method === undefined) return Promise.resolve(json(HISTORY))
      if (input === `${API}/${MEETING_ID}`) return Promise.resolve(json(status))
      if (input === `${API}/${MEETING_ID}/retry`) {
        status = { ...COMPLETE, topic: '重新解析后的周会' }
        return Promise.resolve(json({ id: MEETING_ID, statusUrl: `/status/${MEETING_ID}` }, 202))
      }
      throw new Error(`unexpected request ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    const row = await screen.findByRole('button', { name: /^2026-08-19_09-15_项目周会_5m\.md/ })
    expect(screen.getByText('晨会录音.mp4')).toBeTruthy()
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-19T01:21:00.000Z')
    fireEvent.click(row)

    await screen.findByText('会议纪要已完成')
    expect(screen.getByRole('link', { name: '下载转写原文' }).getAttribute('href'))
      .toBe(`${API}/${MEETING_ID}/transcript`)
    fireEvent.click(screen.getByRole('button', { name: '重新解析' }))
    await screen.findByText('重新解析后的周会')

    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    await screen.findByText('晨会录音.mp4')
    expect(fetchMock.mock.calls.filter(call => call[0] === API)).toHaveLength(2)
  })

  it('submits a selected file with timestamps derived from its duration', async () => {
    probe.seconds = 90
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ meetings: [] }))
      .mockResolvedValueOnce(json({ id: UPLOADED_ID, statusUrl: `/status/${UPLOADED_ID}` }, 202))
      .mockResolvedValueOnce(json({
        id: UPLOADED_ID,
        stage: 'transcribing',
        startedAt: '2026-08-19T01:58:30.000Z',
        endedAt: '2026-08-19T02:00:00.000Z',
        updatedAt: '2026-08-19T02:00:10.000Z',
        completedChunks: 0,
        totalChunks: 2,
        audioReady: true,
      }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('暂无历史录音')
    const chooser = screen.getByLabelText('上传录音')
    fireEvent.change(chooser, { target: { files: [] } })
    fireEvent.change(chooser, {
      target: {
        files: [new File(['recording'], '晨会录音.mp4', {
          type: 'video/mp4',
          lastModified: Date.parse('2026-08-19T02:00:00.000Z'),
        })],
      },
    })

    await screen.findByText('正在本地转写…')
    expect(screen.getByText('晨会录音.mp4')).toBeTruthy()
    const upload = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(upload.method).toBe('POST')
    const headers = upload.headers as Record<string, string>
    expect(headers['content-type']).toBe('video/mp4')
    expect(headers['x-meeting-started-at']).toBe('2026-08-19T01:58:30.000Z')
    expect(headers['x-meeting-ended-at']).toBe('2026-08-19T02:00:00.000Z')
    expect(headers['x-meeting-source-filename']).toBe(encodeURIComponent('晨会录音.mp4'))
  })

  it('deletes a stored meeting after confirmation and keeps processing rows undeletable', async () => {
    const processing = {
      id: 'meeting-20260820T010000-0123456789ab',
      stage: 'transcribing',
      name: 'original.mp4',
      createdAt: '2026-08-20T01:00:00.000Z',
    }
    let listed: unknown = { meetings: [...HISTORY.meetings, processing] }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === API && init?.method === undefined) return Promise.resolve(json(listed))
      if (input === `${API}/${MEETING_ID}` && init?.method === 'DELETE') {
        listed = { meetings: [HISTORY.meetings[1], processing] }
        return Promise.resolve(json({ id: MEETING_ID }))
      }
      throw new Error(`unexpected request ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    const remove = await screen.findByRole('button', { name: '删除 2026-08-19_09-15_项目周会_5m.md' })
    expect(screen.getByRole('button', { name: '删除 original.mp4' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(remove)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '删除 2026-08-19_09-15_项目周会_5m.md' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '删除 2026-08-19_09-15_项目周会_5m.md' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => { expect(screen.queryByText('2026-08-19_09-15_项目周会_5m.md')).toBeNull() })
    expect(screen.getByText('晨会录音.mp4')).toBeTruthy()
    expect(fetchMock.mock.calls.filter(call => call[0] === API)).toHaveLength(2)
  })

  it('reports a meeting the Host refuses to delete', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === API && init?.method === undefined) return Promise.resolve(json(HISTORY))
      return Promise.resolve(json({ error: 'a meeting being processed cannot be deleted' }, 409))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    fireEvent.click(await screen.findByRole('button', { name: '删除 2026-08-19_09-15_项目周会_5m.md' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await screen.findByText('删除失败：a meeting being processed cannot be deleted')
    expect(screen.getByText('2026-08-19_09-15_项目周会_5m.md')).toBeTruthy()
  })

  it('reports a history list that cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'storage root is unreadable' }, 500)))
    render(<MeetingMinutesButton {...props()} />)

    fireEvent.click(screen.getByLabelText('会议纪要'))
    await screen.findByText('读取历史录音失败：storage root is unreadable')
    expect(screen.getByText('暂无历史录音')).toBeTruthy()
  })
})
