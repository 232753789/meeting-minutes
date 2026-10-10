/**
 * Staged edits over the meeting-minutes settings namespace.
 *
 * A control renders what a save would store, and the save runs only when the user asks: every
 * settings write is a durable, revision-fenced document mutation, so a control that committed as
 * it settled would turn each keystroke into a write nobody asked for. An empty draft clears the
 * field, which is what lets a value fall back to the composition layer — none of these fields
 * accepts an empty string, so nothing else could mean.
 */

import {
  createSnapshotStore,
  type SettingsScope,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Namespace the Host plugin registers. Spelled here rather than imported: a browser bundle must
 * not depend on a Host package.
 */
export const MEETING_MINUTES_NS = 'meeting-minutes'

/** Section fields this card edits, in the order the card renders them. */
export const MEETING_SETTINGS_FIELDS = [
  'storageRoot',
  'asrMode',
  'language',
  'localModelPath',
  'pythonExecutable',
  'localDevice',
  'remoteEndpoint',
  'remoteModel',
] as const

/** One editable field name. */
export type MeetingSettingsField = typeof MEETING_SETTINGS_FIELDS[number]

/** The subset of the namespace section this card reads and writes. */
export type MeetingSettingsSection = Partial<Record<MeetingSettingsField, string>>

/** One control's staged state. */
export interface MeetingFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
}

/** What the settings card renders. */
export interface MeetingSettingsCardState {
  /** False while the Host does not serve this namespace; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits a save would write. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
  /** Every control's staged state. */
  fields: Record<MeetingSettingsField, MeetingFieldState>
}

/** The write actions the card's slot entry injects. */
export interface MeetingSettingsActions {
  /** Stage draft text for one field. */
  edit: (field: MeetingSettingsField, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: MeetingSettingsField) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Bridges the meeting-minutes settings scope onto the card's staged form. */
export class MeetingSettingsForm {
  private readonly staged = new Map<MeetingSettingsField, string>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /** @param scope - the bound settings scope for the meeting-minutes namespace. */
  constructor(private readonly scope: SettingsScope<MeetingSettingsSection>) {
    scope.subscribe(() => { this.publish() })
  }

  /**
   * Publish this form's projection, rebuilt whenever the scope or a draft changes.
   * @returns the store the card reads through its bound selector.
   */
  bind(): SnapshotStore<MeetingSettingsCardState> {
    const store = createSnapshotStore(this.state())
    this.listeners.add(() => { store.set(this.state()) })
    return store
  }

  /**
   * Build the actions the card's slot registration injects.
   * @returns the card's edit, reset, save, and discard actions.
   */
  actions(): MeetingSettingsActions {
    return {
      edit: (field, value) => { this.stage(field, value) },
      resetField: (field) => { this.stage(field, '') },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private discard(): void {
    if (this.staged.size === 0 && !this.failed) return
    this.staged.clear()
    this.mark(this.saving, false)
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   *
   * The Host owns the constraints no schema can express, so the outcome is read back from the
   * section instead of predicted here. A save that did not land keeps its drafts.
   * @returns settlement after every write and the read-back.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving) return
    this.mark(true, false)
    let landed = true
    for (const field of plan) landed = await this.write(field) && landed
    if (landed) this.staged.clear()
    this.mark(false, !landed)
  }

  private mark(saving: boolean, failed: boolean): void {
    this.saving = saving
    this.failed = failed
    this.publish()
  }

  private async write(field: MeetingSettingsField): Promise<boolean> {
    const value = this.staged.get(field) ?? ''
    if (value === '') {
      await this.scope.unset(field)
      return !this.stored(field)
    }
    await this.scope.set(field, value)
    return this.user()?.[field] === value
  }

  private plan(): MeetingSettingsField[] {
    return [...this.staged].flatMap(([field, value]) => {
      if (value === '') return this.stored(field) ? [field] : []
      return value === text(this.section()?.[field]) ? [] : [field]
    })
  }

  private state(): MeetingSettingsCardState {
    const snapshot = this.scope.getSnapshot()
    const fields = Object.fromEntries(
      MEETING_SETTINGS_FIELDS.map(field => [field, this.field(field)]),
    ) as Record<MeetingSettingsField, MeetingFieldState>
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.plan().length > 0,
      saving: this.saving,
      failed: this.failed,
      fields,
    }
  }

  private field(field: MeetingSettingsField): MeetingFieldState {
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: text(this.section()?.[field]), overridden: this.stored(field) }
    }
    return { text: staged, overridden: staged !== '' }
  }

  private stage(field: MeetingSettingsField, value: string): void {
    this.staged.set(field, value)
    this.failed = false
    this.publish()
  }

  private section(): MeetingSettingsSection | undefined {
    return this.scope.getSnapshot().value
  }

  private user(): Record<string, unknown> | undefined {
    return this.scope.getSnapshot().user as Record<string, unknown> | undefined
  }

  private stored(field: MeetingSettingsField): boolean {
    const user = this.user()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
