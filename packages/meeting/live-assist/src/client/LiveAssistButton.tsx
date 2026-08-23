/** Composer control: a setup dialog before listening, a compact status bar while it runs. */

import { useCallback, useState, useSyncExternalStore } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MissingSystemAudioError, requestSystemAudioShare } from './audio-capture.ts'
import type { LiveAssistControllerInjected } from './contract.ts'
import type { LiveAssistKey } from './locales.ts'
import type { ControllerState } from './live-controller.ts'
import css from './LiveAssistButton.module.css'

type LiveAssistButtonProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'live-assist'>

const BACKGROUND_KEY = 'dsh.live-assist.background'

function readBackground(): string {
  try {
    return window.localStorage.getItem(BACKGROUND_KEY) ?? ''
  } catch {
    // Storage denied by the browser; the field simply starts empty this time.
    return ''
  }
}

function writeBackground(value: string): void {
  try {
    window.localStorage.setItem(BACKGROUND_KEY, value)
  } catch {
    // Storage denied or full; the value still applies to the session being started.
  }
}

/**
 * Pick the status line for the current controller state.
 * @param state - the controller's current state.
 * @returns the dictionary key describing what the recognizer is doing.
 */
export function statusKey(state: ControllerState): LiveAssistKey {
  if (!state.connected) return 'state.connecting'
  if (state.paused) return 'state.paused'
  if (state.speaking) return 'state.speaking'
  return 'state.listening'
}

/** Composer control whose setup lives in a dialog and whose running state is one inline row. */
export function LiveAssistButton(
  { t, sessionId, controller, isBlankSession }: LiveAssistButtonProps & LiveAssistControllerInjected,
) {
  const [open, setOpen] = useState(false)
  const [background, setBackground] = useState(readBackground)
  const state = useSyncExternalStore(controller.subscribe, controller.getState)

  const [failure, setFailure] = useState<{ key: 'share' | 'missingAudio'; message: string } | null>(null)

  // The share picker opens only while this click is still the transient activation, so nothing
  // is awaited before it: anything else first would spend that activation and leave the picker
  // silently unopened.
  const start = useCallback(async () => {
    setFailure(null)
    let share: MediaStream
    try {
      share = await requestSystemAudioShare()
    } catch (error) {
      if (error instanceof MissingSystemAudioError) setFailure({ key: 'missingAudio', message: '' })
      else setFailure({ key: 'share', message: error instanceof Error ? error.message : String(error) })
      return
    }
    writeBackground(background)
    setOpen(false)
    // The interview joins the conversation the user is already in; the composer is session-scoped,
    // so there is always one.
    controller.start(background, sessionId, share)
  }, [background, controller, sessionId])

  const shown = failure ?? state.failure
  const failureMessage = shown === undefined
    ? null
    : shown.key === 'missingAudio'
      ? t('error.missingAudio')
      : shown.key === 'socket'
        ? t('error.socket', { message: shown.message })
        : t('error.share', { message: shown.message })

  if (state.running) {
    return (
      <span className={css.bar}>
        <StateDot state={state.paused ? 'error' : 'ongoing'} />
        <span className={css.status}>{t(statusKey(state))}</span>
        <Button variant="ghost" onClick={controller.togglePause}>
          {t(state.paused ? 'action.resume' : 'action.pause')}
        </Button>
        <Button variant="ghost" onClick={controller.stop}>{t('action.stop')}</Button>
      </span>
    )
  }

  return (
    <>
      <Button variant="ghost" onClick={() => { setOpen(true) }}>{t('action.open')}</Button>
      {open ? (
        <Modal
          open
          title={t('dialog.title')}
          closeLabel={t('action.close')}
          onClose={() => { setOpen(false) }}
        >
          <p className={css.description}>{t('dialog.description')}</p>
          {isBlankSession(sessionId) ? <p className={css.notice}>{t('hint.blankSession')}</p> : null}
          {failureMessage === null ? null : <p className={css.error}>{failureMessage}</p>}
          {state.error === undefined ? null : <p className={css.error}>{t('error.server', { message: state.error })}</p>}
          <label className={css.field}>
            <span>{t('field.background')}</span>
            <textarea
              className={css.textarea}
              value={background}
              rows={6}
              onChange={(event) => { setBackground(event.target.value) }}
            />
            <small>{t('field.backgroundHint')}</small>
          </label>
          <ul className={css.hints}>
            <li>{t('hint.newSession')}</li>
            <li>{t('hint.share')}</li>
            <li>{t('hint.headphones')}</li>
            <li>{t('hint.screenShare')}</li>
          </ul>
          <div className={css.actions}>
            <Button variant="primary" onClick={() => { void start() }}>{t('action.start')}</Button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
