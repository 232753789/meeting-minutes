/** Browser microphone and system-audio capture, file upload, meeting history, retry, playback, and artifact downloads. */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconDownloadOutline16,
  IconStopFill16,
  Modal,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MeetingAccepted,
  MeetingDeleted,
  MeetingList,
  MeetingListEntry,
  MeetingStage,
  MeetingStatus,
} from '../types.ts'
import type { MeetingMinutesKey } from './locales.ts'
import { mediaDurationSeconds } from './media-duration.ts'
import css from './MeetingMinutesButton.module.css'

/** `idle` is the history list; every other value belongs to one open meeting. */
type LocalPhase = 'idle' | 'requesting' | 'recording' | 'uploading' | 'opening' | 'retrying' | MeetingStage
type MeetingMinutesButtonProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'meeting-minutes'>

const API_PATH = '/meeting-minutes/api/meetings'
/** Microphone selection meaning "whatever the operating system currently uses". */
const MICROPHONE_SYSTEM = 'system'
/** Microphone selection meaning "record no microphone at all". */
const MICROPHONE_NONE = 'none'
const PREFERENCES_KEY = 'dsh.meeting-minutes.capture'
const UPLOAD_ACCEPT = '.mp4,audio/mp4,video/mp4'
const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const

const PHASE_KEYS = {
  requesting: 'state.requesting',
  recording: 'state.recording',
  uploading: 'state.uploading',
  opening: 'state.opening',
  retrying: 'state.retrying',
  queued: 'state.queued',
  normalizing: 'state.normalizing',
  transcribing: 'state.transcribing',
  summarizing: 'state.summarizing',
  complete: 'state.complete',
  failed: 'state.failed',
} as const satisfies Record<Exclude<LocalPhase, 'idle'>, MeetingMinutesKey>

/** Audio sources one recording captures; `microphone` is a device id or one of the two sentinels. */
interface CapturePreferences {
  readonly microphone: string
  readonly systemAudio: boolean
}

/** Microphone devices are named only after the browser has granted microphone access once. */
type MicrophoneChoices =
  | { readonly kind: 'unrevealed' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'listed'; readonly devices: readonly MediaDeviceInfo[] }

const DEFAULT_PREFERENCES: CapturePreferences = { microphone: MICROPHONE_SYSTEM, systemAudio: false }

function readPreferences(): CapturePreferences {
  let stored: unknown
  try {
    stored = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? 'null')
  } catch {
    // Storage denied by the browser, or a hand-edited value that is not JSON: the defaults apply.
    return DEFAULT_PREFERENCES
  }
  if (typeof stored !== 'object' || stored === null) return DEFAULT_PREFERENCES
  const value = stored as Partial<CapturePreferences>
  return {
    microphone: typeof value.microphone === 'string' ? value.microphone : MICROPHONE_SYSTEM,
    systemAudio: value.systemAudio === true,
  }
}

function writePreferences(preferences: CapturePreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // Storage denied or full; the choice still applies to the recording being started.
  }
}

function mediaDevicesOf(): MediaDevices | undefined {
  return (navigator as unknown as { mediaDevices?: MediaDevices }).mediaDevices
}

/** Whether the selection leaves at least one audio source to record. */
function hasAudioSource(preferences: CapturePreferences): boolean {
  return preferences.microphone !== MICROPHONE_NONE || preferences.systemAudio
}

function preferredMimeType(): string | undefined {
  return MIME_CANDIDATES.find(candidate => MediaRecorder.isTypeSupported(candidate))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timerText(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours, minutes, rest].map(value => String(value).padStart(2, '0')).join(':')
}

function indicatorState(phase: Exclude<LocalPhase, 'idle'>): 'error' | 'done' | 'ongoing' {
  return phase === 'failed' ? 'error' : phase === 'complete' ? 'done' : 'ongoing'
}

function deletable(stage: MeetingStage): boolean {
  return stage === 'complete' || stage === 'failed'
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json()
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && !Array.isArray(body)
      && typeof (body as Record<string, unknown>).error === 'string'
      ? (body as Record<string, string>).error
      : `HTTP ${String(response.status)}`
    throw new Error(message)
  }
  return body as T
}

/** Composer control whose modal keeps the meeting history and one recording/result lifecycle in local state. */
export function MeetingMinutesButton({ t }: MeetingMinutesButtonProps) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<LocalPhase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [meetings, setMeetings] = useState<readonly MeetingListEntry[] | null>(null)
  const [listRevision, setListRevision] = useState(0)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<MeetingStatus | null>(null)
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [meetingName, setMeetingName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<CapturePreferences>(readPreferences)
  const [microphones, setMicrophones] = useState<MicrophoneChoices>({ kind: 'unrevealed' })
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const displayStream = useRef<MediaStream | null>(null)
  const mixer = useRef<AudioContext | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef<Date | null>(null)
  const cancelled = useRef(false)

  const releaseStream = useCallback(() => {
    for (const track of stream.current?.getTracks() ?? []) track.stop()
    stream.current = null
    for (const track of displayStream.current?.getTracks() ?? []) track.stop()
    displayStream.current = null
    mixer.current?.close().catch(() => {
      // A context already closed by an earlier teardown is the only rejection here, and nothing observes it.
    })
    mixer.current = null
  }, [])

  const submit = useCallback(async (blob: Blob, start: Date, end: Date, source?: string) => {
    setPhase('uploading')
    setError(null)
    try {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: {
          'content-type': blob.type || 'audio/webm',
          'x-meeting-started-at': start.toISOString(),
          'x-meeting-ended-at': end.toISOString(),
          ...(source === undefined ? {} : { 'x-meeting-source-filename': encodeURIComponent(source) }),
        },
        body: blob,
      })
      const accepted = await jsonResponse<MeetingAccepted>(response)
      setMeetingId(accepted.id)
      setPhase('queued')
    } catch (uploadError) {
      setError(t('error.upload', { message: errorMessage(uploadError) }))
      setPhase('failed')
    }
  }, [t])

  const leaveList = useCallback((name: string | null) => {
    setConfirmingDelete(null)
    setError(null)
    setMeeting(null)
    setMeetingId(null)
    setMeetingName(name)
    setElapsed(0)
  }, [])

  const choose = useCallback((next: CapturePreferences) => {
    writePreferences(next)
    setPreferences(next)
  }, [])

  /**
   * List the microphones for the dropdown, requesting access once so the devices carry their names.
   *
   * A selection whose device is gone falls back to the system device, which is what a browser would
   * pick for the recording anyway.
   */
  const revealMicrophones = useCallback(async () => {
    const mediaDevices = mediaDevicesOf()
    if (mediaDevices === undefined) return
    if (microphones.kind !== 'listed') {
      try {
        const granted = await mediaDevices.getUserMedia({ audio: true })
        for (const track of granted.getTracks()) track.stop()
      } catch {
        setMicrophones({ kind: 'denied' })
        return
      }
    }
    const devices = (await mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')
    setMicrophones({ kind: 'listed', devices })
    const selected = preferences.microphone
    if (selected === MICROPHONE_SYSTEM || selected === MICROPHONE_NONE) return
    if (!devices.some(device => device.deviceId === selected)) {
      choose({ ...preferences, microphone: MICROPHONE_SYSTEM })
    }
  }, [choose, microphones.kind, preferences])

  const stopRecording = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  /**
   * Capture the microphone alone, or summed with the shared system audio.
   *
   * MediaRecorder records a single audio track, so both sources are mixed through an AudioContext.
   * The shared video track stays live because stopping it ends the share and its audio with it; the
   * user ending the share from the browser's own banner stops the recording and submits it.
   */
  const capture = useCallback(async (
    mediaDevices: MediaDevices,
    choice: CapturePreferences,
  ): Promise<MediaStream | null> => {
    if (choice.microphone !== MICROPHONE_NONE) {
      try {
        stream.current = await mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(choice.microphone === MICROPHONE_SYSTEM ? {} : { deviceId: choice.microphone }),
          },
        })
      } catch (microphoneError) {
        setError(t('error.microphone', { message: errorMessage(microphoneError) }))
        return null
      }
    }
    if (!choice.systemAudio) return stream.current
    let display: MediaStream
    try {
      display = await mediaDevices.getDisplayMedia({ video: true, audio: true })
    } catch (shareError) {
      setError(t('error.systemAudio', { message: errorMessage(shareError) }))
      return null
    }
    displayStream.current = display
    if (display.getAudioTracks().length === 0) {
      setError(t('error.systemAudioMissing'))
      return null
    }
    display.getVideoTracks()[0]?.addEventListener('ended', stopRecording)
    const context = new AudioContext()
    mixer.current = context
    const destination = context.createMediaStreamDestination()
    const microphone = stream.current
    for (const source of microphone === null ? [display] : [microphone, display]) {
      context.createMediaStreamSource(source).connect(destination)
    }
    return destination.stream
  }, [stopRecording, t])

  const startRecording = useCallback(async (choice: CapturePreferences) => {
    const mediaDevices = mediaDevicesOf()
    leaveList(null)
    if (typeof MediaRecorder === 'undefined' || mediaDevices === undefined) {
      setError(t('error.unsupported'))
      setPhase('failed')
      return
    }
    setOpen(true)
    setPhase('requesting')
    cancelled.current = false
    const recorded = await capture(mediaDevices, choice)
    if (recorded === null) {
      releaseStream()
      setPhase('failed')
      return
    }
    try {
      const mimeType = preferredMimeType()
      const next = mimeType === undefined
        ? new MediaRecorder(recorded)
        : new MediaRecorder(recorded, { mimeType })
      chunks.current = []
      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data)
      }
      next.onstop = () => {
        releaseStream()
        recorder.current = null
        const start = startedAt.current
        startedAt.current = null
        if (cancelled.current || start === null) return
        const blob = new Blob(chunks.current, { type: next.mimeType || mimeType || 'audio/webm' })
        chunks.current = []
        void submit(blob, start, new Date())
      }
      startedAt.current = new Date()
      recorder.current = next
      next.start(1_000)
      setPhase('recording')
    } catch (recorderError) {
      releaseStream()
      setError(t('error.recorder', { message: errorMessage(recorderError) }))
      setPhase('failed')
    }
  }, [capture, leaveList, releaseStream, submit, t])

  const uploadFile = useCallback(async (file: File) => {
    leaveList(file.name)
    setPhase('uploading')
    const ended = new Date(file.lastModified)
    const seconds = await mediaDurationSeconds(file)
    await submit(file, new Date(ended.getTime() - Math.round(seconds * 1_000)), ended, file.name)
  }, [leaveList, submit])

  const openMeeting = useCallback((entry: MeetingListEntry) => {
    setConfirmingDelete(null)
    setError(null)
    setMeeting(null)
    setMeetingName(entry.name)
    setMeetingId(entry.id)
    setPhase('opening')
  }, [])

  const backToList = useCallback(() => {
    setConfirmingDelete(null)
    setError(null)
    setMeeting(null)
    setMeetingId(null)
    setMeetingName(null)
    setPhase('idle')
  }, [])

  const retryProcessing = useCallback(async () => {
    if (meetingId === null) return
    setPhase('retrying')
    setError(null)
    setMeeting((current) => {
      if (current === null) return null
      const { error: _error, ...withoutError } = current
      return withoutError
    })
    try {
      const response = await fetch(`${API_PATH}/${encodeURIComponent(meetingId)}/retry`, { method: 'POST' })
      await jsonResponse<MeetingAccepted>(response)
      setMeeting((current) => {
        if (current === null) return null
        const {
          totalChunks: _totalChunks,
          topic: _topic,
          transcript: _transcript,
          summaryMarkdown: _summaryMarkdown,
          minutesFilename: _minutesFilename,
          error: _error,
          ...retained
        } = current
        return { ...retained, stage: 'queued', completedChunks: 0, audioReady: false }
      })
      setPhase('queued')
    } catch (retryError) {
      setError(t('error.retry', { message: errorMessage(retryError) }))
      setPhase('failed')
    }
  }, [meetingId, t])

  const deleteMeeting = useCallback(async (id: string) => {
    setConfirmingDelete(null)
    setError(null)
    try {
      const response = await fetch(`${API_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await jsonResponse<MeetingDeleted>(response)
      setListRevision(value => value + 1)
    } catch (deleteError) {
      setError(t('error.delete', { message: errorMessage(deleteError) }))
    }
  }, [t])

  useEffect(() => {
    if (!open || phase !== 'idle') return
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(API_PATH, { signal: controller.signal, cache: 'no-store' })
        setMeetings((await jsonResponse<MeetingList>(response)).meetings)
      } catch (listError) {
        if (controller.signal.aborted) return
        setMeetings([])
        setError(t('error.list', { message: errorMessage(listError) }))
      }
    }
    void load()
    return () => { controller.abort() }
  }, [listRevision, open, phase, t])

  useEffect(() => {
    if (phase !== 'recording') return
    const timer = window.setInterval(() => { setElapsed(value => value + 1) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [phase])

  useEffect(() => {
    if (meetingId === null || phase === 'complete' || phase === 'failed') return
    const controller = new AbortController()
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_PATH}/${encodeURIComponent(meetingId)}`, {
          signal: controller.signal,
          cache: 'no-store',
        })
        const status = await jsonResponse<MeetingStatus>(response)
        setMeeting(status)
        setPhase(status.stage)
        if (status.stage !== 'complete' && status.stage !== 'failed') {
          timer = window.setTimeout(() => { void poll() }, 1_500)
        }
      } catch (pollError) {
        if (controller.signal.aborted) return
        setError(t('error.upload', { message: errorMessage(pollError) }))
        setPhase('failed')
      }
    }
    void poll()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [meetingId, phase, t])

  useEffect(() => () => {
    cancelled.current = true
    if (recorder.current?.state === 'recording') recorder.current.stop()
    releaseStream()
  }, [releaseStream])

  const processing = phase === 'uploading' || phase === 'retrying' || phase === 'opening' || phase === 'queued'
    || phase === 'normalizing' || phase === 'transcribing' || phase === 'summarizing'
  const reprocessable = meetingId !== null && (meeting?.stage === 'failed' || meeting?.stage === 'complete')
  const buttonLabel = phase === 'recording'
    ? `${t('state.recording')} ${timerText(elapsed)}`
    : t('action.open')

  return (
    <>
      <button
        type="button"
        className={css.toolbarButton}
        data-recording={phase === 'recording' ? 'true' : 'false'}
        onClick={() => { setOpen(true) }}
        aria-label={buttonLabel}
        title={buttonLabel}
      >
        <span className={css.mic} aria-hidden="true" />
        {phase === 'recording' && <span className={css.toolbarTimer}>{timerText(elapsed)}</span>}
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('dialog.title')}
        closeLabel={t('action.close')}
        description={t('dialog.description')}
        className={css.dialog as string}
        contentClassName={css.content as string}
        footer={(
          <div className={css.footerActions}>
            {phase === 'idle' && (
              <>
                <label className={css.microphone}>
                  <select
                    className={css.microphoneSelect}
                    value={preferences.microphone}
                    aria-label={t('action.microphone')}
                    onFocus={() => { void revealMicrophones() }}
                    onPointerDown={() => { void revealMicrophones() }}
                    onChange={(event) => { choose({ ...preferences, microphone: event.target.value }) }}
                  >
                    <option value={MICROPHONE_SYSTEM}>{t('option.microphoneSystem')}</option>
                    <option value={MICROPHONE_NONE}>{t('option.microphoneNone')}</option>
                    {microphones.kind === 'listed' && microphones.devices.map(device => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                    ))}
                    {microphones.kind !== 'listed'
                      && preferences.microphone !== MICROPHONE_SYSTEM
                      && preferences.microphone !== MICROPHONE_NONE
                      && <option value={preferences.microphone}>{t('option.microphoneSaved')}</option>}
                    {microphones.kind === 'denied'
                      && <option value="" disabled>{t('option.microphoneDenied')}</option>}
                  </select>
                </label>
                <Button
                  variant="primary"
                  disabled={!hasAudioSource(preferences)}
                  onClick={() => { void startRecording(preferences) }}
                >
                  {t('action.start')}
                </Button>
                <label className={css.upload}>
                  <input
                    type="file"
                    className={css.fileInput}
                    accept={UPLOAD_ACCEPT}
                    aria-label={t('action.upload')}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file !== undefined) void uploadFile(file)
                    }}
                  />
                  {t('action.upload')}
                </label>
                <label className={css.systemAudio} title={t('action.systemAudioHint')}>
                  <input
                    type="checkbox"
                    checked={preferences.systemAudio}
                    onChange={(event) => { choose({ ...preferences, systemAudio: event.target.checked }) }}
                  />
                  {t('action.systemAudio')}
                </label>
                {!hasAudioSource(preferences) && <span className={css.noSource}>{t('hint.noSource')}</span>}
              </>
            )}
            {phase === 'recording' && (
              <Button variant="primary" icon={<IconStopFill16 size={14} />} onClick={stopRecording}>
                {t('action.stop')}
              </Button>
            )}
            {phase === 'failed' && meetingId === null && (
              <Button
                variant="primary"
                disabled={!hasAudioSource(preferences)}
                onClick={() => { void startRecording(preferences) }}
              >
                {t('action.recordAgain')}
              </Button>
            )}
            {reprocessable && (
              <Button variant="primary" onClick={() => { void retryProcessing() }} disabled={processing}>
                {t('action.retryProcessing')}
              </Button>
            )}
            {phase === 'complete' && meetingId !== null && (
              <a className={css.download} href={`${API_PATH}/${encodeURIComponent(meetingId)}/minutes`} download>
                <IconDownloadOutline16 size={14} />
                {t('action.download')}
              </a>
            )}
            {meetingId !== null && meeting?.transcript !== undefined && (
              <a className={css.download} href={`${API_PATH}/${encodeURIComponent(meetingId)}/transcript`} download>
                <IconDownloadOutline16 size={14} />
                {t('action.downloadTranscript')}
              </a>
            )}
            {meetingId !== null && (
              <a className={css.download} href={`${API_PATH}/${encodeURIComponent(meetingId)}/original`} download>
                <IconDownloadOutline16 size={14} />
                {t('action.downloadOriginal')}
              </a>
            )}
            {phase !== 'idle' && phase !== 'recording' && phase !== 'requesting' && (
              <Button variant="outline" onClick={backToList}>{t('action.back')}</Button>
            )}
          </div>
        )}
      >
        {phase === 'idle' && (
          <div className={css.list}>
            <div className={css.listHead}>
              <span>{t('list.name')}</span>
              <span>{t('list.created')}</span>
            </div>
            {meetings === null && <p className={css.listEmpty}>{t('list.loading')}</p>}
            {meetings?.length === 0 && <p className={css.listEmpty}>{t('list.empty')}</p>}
            {meetings?.map(entry => (
              <div key={entry.id} className={css.listRow}>
                <button type="button" className={css.listOpen} onClick={() => { openMeeting(entry) }}>
                  <span className={css.listName}>
                    <StateDot state={indicatorState(entry.stage)} />
                    <span className={css.listNameText}>{entry.name}</span>
                  </span>
                  <time className={css.listCreated} dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </time>
                </button>
                <div className={css.listActions}>
                  {confirmingDelete === entry.id
                    ? (
                      <>
                        <button
                          type="button"
                          className={css.listConfirm}
                          onClick={() => { void deleteMeeting(entry.id) }}
                        >
                          {t('action.deleteConfirm')}
                        </button>
                        <button
                          type="button"
                          className={css.listCancel}
                          onClick={() => { setConfirmingDelete(null) }}
                        >
                          {t('action.cancel')}
                        </button>
                      </>
                    )
                    : (
                      <button
                        type="button"
                        className={css.listDelete}
                        disabled={!deletable(entry.stage)}
                        aria-label={t('action.deleteMeeting', { name: entry.name })}
                        onClick={() => { setConfirmingDelete(entry.id) }}
                      >
                        {t('action.delete')}
                      </button>
                    )}
                </div>
              </div>
            ))}
          </div>
        )}
        {phase !== 'idle' && (
          <div className={css.status}>
            <StateDot state={indicatorState(phase)} />
            <span>{`${t(PHASE_KEYS[phase])}${phase === 'recording' ? ` · ${timerText(elapsed)}` : ''}`}</span>
            {phase === 'transcribing' && meeting?.totalChunks !== undefined && (
              <span className={css.progress}>{meeting.completedChunks}/{meeting.totalChunks}</span>
            )}
          </div>
        )}
        {error !== null && <p className={css.error} role="alert">{error}</p>}
        {meeting?.error !== undefined && <p className={css.error} role="alert">{meeting.error}</p>}
        {meetingName !== null && (
          <div className={css.resultBlock}>
            <strong>{t('result.source')}</strong>
            <span>{meetingName}</span>
          </div>
        )}
        {meeting?.audioReady === true && meetingId !== null && (
          <div className={css.resultBlock}>
            <strong>{t('result.audio')}</strong>
            <audio className={css.audio} controls src={`${API_PATH}/${encodeURIComponent(meetingId)}/audio`} />
          </div>
        )}
        {meeting?.topic !== undefined && (
          <div className={css.resultBlock}>
            <strong>{t('result.topic')}</strong>
            <span>{meeting.topic}</span>
          </div>
        )}
        {meeting?.summaryMarkdown !== undefined && (
          <div className={css.resultBlock}>
            <strong>{t('result.summary')}</strong>
            <pre className={css.summary}>{meeting.summaryMarkdown}</pre>
          </div>
        )}
        {meeting?.transcript !== undefined && (
          <details className={css.transcript}>
            <summary>{t('result.transcript')}</summary>
            <pre>{meeting.transcript}</pre>
          </details>
        )}
      </Modal>
    </>
  )
}
