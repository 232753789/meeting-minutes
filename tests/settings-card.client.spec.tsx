// @vitest-environment jsdom

import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import { MeetingMinutesSettingsCard } from '../src/client/MeetingMinutesSettingsCard.tsx'
import { MeetingSettingsForm, type MeetingSettingsSection } from '../src/client/settings-form.ts'
import { zh } from '../src/client/locales.ts'

/** A scope whose document is one in-memory section, as the Host would resolve it. */
class FakeScope implements SettingsScope<MeetingSettingsSection> {
  readonly writes: [string, unknown][] = []
  private readonly listeners = new Set<() => void>()
  private snapshot: SettingsScopeSnapshot<MeetingSettingsSection>

  constructor(
    value: MeetingSettingsSection,
    options: { status?: 'loading' | 'ready'; writable?: boolean; user?: MeetingSettingsSection } = {},
  ) {
    this.snapshot = {
      status: options.status ?? 'ready',
      value,
      base: value,
      user: options.user ?? {},
      revision: 1,
      writable: options.writable ?? true,
      mode: 'host',
    }
  }

  getSnapshot(): SettingsScopeSnapshot<MeetingSettingsSection> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(field: string, value: unknown): Promise<void> {
    this.writes.push([field, value])
    this.publish({
      value: { ...this.snapshot.value, [field]: value as string },
      user: { ...this.snapshot.user as MeetingSettingsSection, [field]: value as string },
    })
    return Promise.resolve()
  }

  unset(field: string): Promise<void> {
    this.writes.push([field, undefined])
    const { [field as keyof MeetingSettingsSection]: _cleared, ...user } = this.snapshot.user as MeetingSettingsSection
    this.publish({ user })
    return Promise.resolve()
  }

  private publish(patch: Partial<SettingsScopeSnapshot<MeetingSettingsSection>>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function mount(scope: FakeScope): MeetingSettingsForm {
  const form = new MeetingSettingsForm(scope)
  const store = form.bind()
  const t = (key: keyof typeof zh): string => zh[key]
  const Card = (): ReturnType<typeof MeetingMinutesSettingsCard> => MeetingMinutesSettingsCard({
    t,
    useMeetingSettingsCard: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) =>
      useSyncExternalStore(listener => store.subscribe(listener), () => selector(store.getSnapshot())),
    ...form.actions(),
  } as unknown as Parameters<typeof MeetingMinutesSettingsCard>[0])
  render(<Card />)
  return form
}

afterEach(() => { cleanup() })

describe('meeting-minutes settings card', () => {
  it('renders nothing until the Host serves the namespace', () => {
    mount(new FakeScope({}, { status: 'loading' }))
    expect(screen.queryByText('会议纪要')).toBeNull()
  })

  it('saves the storage path and the ASR route a user edited', async () => {
    const scope = new FakeScope({
      storageRoot: '/data/meetings',
      asrMode: 'local',
      language: 'Chinese',
      localModelPath: '/models/Qwen3-ASR-1.7B',
      pythonExecutable: 'python3',
      localDevice: 'auto',
      remoteEndpoint: 'http://127.0.0.1:8000/v1/chat/completions',
      remoteModel: 'Qwen/Qwen3-ASR-1.7B',
    })
    mount(scope)

    fireEvent.click(screen.getByRole('button', { name: '展开: 会议纪要' }))
    const storageRoot = screen.getByLabelText('存储目录')
    expect((storageRoot as HTMLInputElement).value).toBe('/data/meetings')
    fireEvent.change(storageRoot, { target: { value: '/srv/meetings' } })
    fireEvent.change(screen.getByLabelText('推理设备'), { target: { value: 'mps' } })

    expect(screen.getByText('未保存')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => { expect(scope.writes).toHaveLength(2) })
    expect(scope.writes).toEqual([['storageRoot', '/srv/meetings'], ['localDevice', 'mps']])
    await waitFor(() => { expect(screen.queryByText('未保存')).toBeNull() })
  })

  it('clears one overridden field so it re-inherits the composed value', async () => {
    const scope = new FakeScope(
      { storageRoot: '/srv/meetings', asrMode: 'local' },
      { user: { storageRoot: '/srv/meetings' } },
    )
    mount(scope)

    fireEvent.click(screen.getByRole('button', { name: '展开: 会议纪要' }))
    expect(screen.getByText('已覆盖')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => { expect(scope.writes).toEqual([['storageRoot', undefined]]) })
  })

  it('disables every control while the settings document is read-only', () => {
    mount(new FakeScope({ storageRoot: '/data/meetings' }, { writable: false }))

    fireEvent.click(screen.getByRole('button', { name: '展开: 会议纪要' }))
    expect(screen.getByText('当前设置文档为只读，无法修改。')).toBeTruthy()
    expect(screen.getByLabelText('存储目录').hasAttribute('disabled')).toBe(true)
  })
})
