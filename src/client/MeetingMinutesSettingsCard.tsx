/**
 * The meeting-minutes card in the plugin configuration page: where recordings are stored and
 * which ASR route transcribes them.
 *
 * A save replaces the running installation, which is why the card says so before the user commits:
 * the resolved configuration is frozen into the processing runtime and the persistent ASR worker,
 * so a meeting still being processed is interrupted.
 */

import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { MeetingMinutesKey } from './locales.ts'
import type {
  MeetingSettingsActions,
  MeetingSettingsCardState,
  MeetingSettingsField,
} from './settings-form.ts'
import css from './MeetingMinutesSettingsCard.module.css'

/** The registration-side face this card's slot entry injects. */
export interface MeetingSettingsCardFace extends MeetingSettingsActions {
  hooks: {
    /** Card snapshot bound by the renderer as useMeetingSettingsCard. */
    meetingSettingsCard: SnapshotStore<MeetingSettingsCardState>
  }
}

/** Props the renderer binds for the meeting-minutes settings card. */
export type MeetingMinutesSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'meeting-minutes'>
  & InjectFace<MeetingSettingsCardFace>

/** One field's label and explanation. */
interface FieldCopy {
  field: MeetingSettingsField
  label: MeetingMinutesKey
  hint: MeetingMinutesKey
  /** Fixed choices, for a field whose schema is a union. */
  options?: readonly { value: string; label: MeetingMinutesKey }[]
}

const FIELDS: readonly FieldCopy[] = [
  { field: 'storageRoot', label: 'settings.storageRoot', hint: 'settings.storageRootHint' },
  {
    field: 'asrMode',
    label: 'settings.asrMode',
    hint: 'settings.asrModeHint',
    options: [
      { value: 'local', label: 'settings.modeLocal' },
      { value: 'remote', label: 'settings.modeRemote' },
    ],
  },
  { field: 'language', label: 'settings.language', hint: 'settings.languageHint' },
  { field: 'localModelPath', label: 'settings.localModelPath', hint: 'settings.localModelPathHint' },
  { field: 'pythonExecutable', label: 'settings.pythonExecutable', hint: 'settings.pythonExecutableHint' },
  {
    field: 'localDevice',
    label: 'settings.localDevice',
    hint: 'settings.localDeviceHint',
    options: [
      { value: 'auto', label: 'settings.deviceAuto' },
      { value: 'cuda', label: 'settings.deviceCuda' },
      { value: 'mps', label: 'settings.deviceMps' },
      { value: 'cpu', label: 'settings.deviceCpu' },
    ],
  },
  { field: 'remoteEndpoint', label: 'settings.remoteEndpoint', hint: 'settings.remoteEndpointHint' },
  { field: 'remoteModel', label: 'settings.remoteModel', hint: 'settings.remoteModelHint' },
]

/**
 * Render the meeting-minutes settings card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the Host does not serve the namespace.
 */
export function MeetingMinutesSettingsCard(props: MeetingMinutesSettingsCardProps) {
  const { t } = props
  const [open, setOpen] = useState(false)
  const state = props.useMeetingSettingsCard(snapshot => snapshot)
  if (!state.available) return null
  const title = t('settings.title')
  const disabled = !state.writable
  return (
    <li className={open ? css.cardOpen : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty && <span className={css.pending}>{t('settings.unsaved')}</span>}
        <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
      </button>
      {open && (
        <div className={css.body}>
          {disabled && <p className={css.notice} role="status">{t('settings.readOnly')}</p>}
          {FIELDS.map(copy => (
            <SettingRow
              key={copy.field}
              id={`plugin-config-meeting-minutes-${copy.field}`}
              label={t(copy.label)}
              hint={t(copy.hint)}
              resetLabel={t('settings.reset')}
              overriddenLabel={t('settings.overridden')}
              disabled={disabled}
              text={state.fields[copy.field].text}
              overridden={state.fields[copy.field].overridden}
              onEdit={(text) => { props.edit(copy.field, text) }}
              onReset={() => { props.resetField(copy.field) }}
            >
              {copy.options === undefined ? undefined : (
                <select
                  id={`plugin-config-meeting-minutes-${copy.field}`}
                  className={css.input}
                  disabled={disabled}
                  value={state.fields[copy.field].text}
                  onChange={(event) => { props.edit(copy.field, event.target.value) }}
                >
                  {copy.options.map(option => (
                    <option key={option.value} value={option.value}>{t(option.label)}</option>
                  ))}
                </select>
              )}
            </SettingRow>
          ))}
          <p className={css.notice}>{t('settings.applyNote')}</p>
          <div className={css.footer}>
            {state.failed && <p className={css.failed} role="status">{t('settings.saveFailed')}</p>}
            <button
              type="button"
              className={css.discard}
              disabled={!state.dirty || state.saving}
              onClick={props.discard}
            >
              {t('settings.discard')}
            </button>
            <button
              type="button"
              className={css.save}
              disabled={!state.dirty || state.saving}
              onClick={props.save}
            >
              {t(state.saving ? 'settings.saving' : 'settings.save')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/** One labelled control: the supplied select, or a text input when none is given. */
function SettingRow(props: {
  id: string
  label: string
  hint: string
  resetLabel: string
  overriddenLabel: string
  disabled: boolean
  text: string
  overridden: boolean
  onEdit: (text: string) => void
  onReset: () => void
  children?: ReactNode
}) {
  return (
    <div className={css.field}>
      <div className={css.fieldHead}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden && (
          <span className={css.badges}>
            <span className={css.badge}>{props.overriddenLabel}</span>
            <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        )}
      </div>
      {props.children ?? (
        <input
          id={props.id}
          className={css.input}
          type="text"
          value={props.text}
          disabled={props.disabled}
          onChange={(event) => { props.onEdit(event.target.value) }}
        />
      )}
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
