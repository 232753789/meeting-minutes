// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MissingSystemAudioError } from '../src/client/audio-capture.ts'
import { ExchangeCard } from '../src/client/ExchangeCard.tsx'
import { LiveAssistButton, statusKey } from '../src/client/LiveAssistButton.tsx'
import { LiveAssistController, type ControllerState } from '../src/client/live-controller.ts'
import { zh } from '../src/client/locales.ts'

const shareStop = vi.fn()
const shareProbe = vi.hoisted(() => ({ failWith: undefined as unknown }))

vi.mock('../src/client/audio-capture.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/audio-capture.ts')>()
  return {
    ...actual,
    requestSystemAudioShare: () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error case is under test
      if (shareProbe.failWith !== undefined) return Promise.reject(shareProbe.failWith)
      return Promise.resolve({ getTracks: () => [] } as unknown as MediaStream)
    },
  }
})

function t(key: keyof typeof zh, params?: Record<string, unknown>): string {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

/** A controller stub whose state the test drives directly. */
function stub(state: Partial<ControllerState>) {
  let current = { connected: false, speaking: false, running: false, paused: false, ...state } as ControllerState
  const listeners = new Set<() => void>()
  const mocks = { adopt: vi.fn(), request: vi.fn(), stop: vi.fn(), togglePause: vi.fn() }
  return {
    mocks,
    controller: {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      getState: () => current,
      awaiting: false,
      ...mocks,
    } as unknown as LiveAssistController,
    set: (next: Partial<ControllerState>) => {
      current = { ...current, ...next }
      for (const listener of listeners) listener()
    },
  }
}

function renderButton(overrides: {
  state?: Partial<ControllerState>
  sessionId?: SessionId
  startSession?: () => void
  blank?: boolean
} = {}) {
  const { controller, mocks } = stub(overrides.state ?? {})
  const startSession = overrides.startSession ?? vi.fn()
  const props = {
    t,
    sessionId: overrides.sessionId ?? ('session-a' as SessionId),
    controller,
    startSession,
    isBlankSession: () => overrides.blank ?? false,
  } as unknown as ComponentProps<typeof LiveAssistButton>
  render(<LiveAssistButton {...props} />)
  return { controller, mocks, startSession }
}

beforeEach(() => {
  shareStop.mockClear()
  shareProbe.failWith = undefined
  window.localStorage.clear()
})
afterEach(() => { cleanup() })

describe('statusKey', () => {
  it.each([
    ['connecting', { connected: false, speaking: false, paused: false }, 'state.connecting'],
    ['paused', { connected: true, speaking: false, paused: true }, 'state.paused'],
    ['speaking', { connected: true, speaking: true, paused: false }, 'state.speaking'],
    ['listening', { connected: true, speaking: false, paused: false }, 'state.listening'],
  ])('reports %s', (_label, state, expected) => {
    expect(statusKey({ ...state, running: true })).toBe(expected)
  })
})

describe('LiveAssistButton before listening', () => {
  it('opens a setup dialog explaining the new session', () => {
    renderButton()
    fireEvent.click(screen.getByText(zh['action.open']))
    expect(screen.getByText(zh['hint.newSession'])).toBeTruthy()
    expect(screen.getByText(zh['hint.screenShare'])).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('opens the share picker on the click, then creates the session', async () => {
    const startSession = vi.fn()
    const { mocks } = renderButton({ sessionId: 'session-a' as SessionId, startSession })
    fireEvent.click(screen.getByText(zh['action.open']))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '五年 Go' } })
    fireEvent.click(screen.getByText(zh['action.start']))

    // The share must be obtained inside the click; the session is created only afterwards.
    await waitFor(() => { expect(mocks.request).toHaveBeenCalled() })
    expect(mocks.request).toHaveBeenCalledWith('五年 Go', 'session-a', expect.anything())
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(zh['dialog.title'])).toBeNull()
    expect(window.localStorage.getItem('dsh.live-assist.background')).toBe('五年 Go')
  })

  it('listens in the blank session it is already in, creating no other', async () => {
    const startSession = vi.fn()
    const { mocks } = renderButton({ sessionId: 'session-a' as SessionId, startSession, blank: true })
    fireEvent.click(screen.getByText(zh['action.open']))
    fireEvent.click(screen.getByText(zh['action.start']))

    // New Session would hand back this same blank session, so no switch is requested and the
    // request is adopted here — waiting for a different session would wait forever.
    await waitFor(() => { expect(mocks.request).toHaveBeenCalled() })
    expect(mocks.request).toHaveBeenCalledWith('', undefined, expect.anything())
    expect(mocks.adopt).toHaveBeenCalledWith('session-a')
    expect(startSession).not.toHaveBeenCalled()
  })

  it('reports a refused share and creates no session', async () => {
    shareProbe.failWith = new Error('用户取消了共享')
    const startSession = vi.fn()
    const { mocks } = renderButton({ startSession })
    fireEvent.click(screen.getByText(zh['action.open']))
    fireEvent.click(screen.getByText(zh['action.start']))
    await waitFor(() => { expect(screen.getByText(/用户取消了共享/)).toBeTruthy() })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
    // The dialog stays open so the user can simply try again.
    expect(screen.getByText(zh['dialog.title'])).toBeTruthy()
  })

  it('stringifies a non-Error share refusal', async () => {
    shareProbe.failWith = '系统策略阻止了屏幕共享'
    renderButton()
    fireEvent.click(screen.getByText(zh['action.open']))
    fireEvent.click(screen.getByText(zh['action.start']))
    await waitFor(() => { expect(screen.getByText(/系统策略阻止了屏幕共享/)).toBeTruthy() })
  })

  it('reports a share that carried no audio', async () => {
    shareProbe.failWith = new MissingSystemAudioError()
    renderButton()
    fireEvent.click(screen.getByText(zh['action.open']))
    fireEvent.click(screen.getByText(zh['action.start']))
    await waitFor(() => { expect(screen.getByText(zh['error.missingAudio'])).toBeTruthy() })
  })

  it('renders a capture failure the controller reported', () => {
    renderButton({ state: { failure: { key: 'missingAudio', message: '' } } })
    fireEvent.click(screen.getByText(zh['action.open']))
    expect(screen.getByText(zh['error.missingAudio'])).toBeTruthy()
  })

  it('renders a socket failure with its detail', () => {
    renderButton({ state: { failure: { key: 'socket', message: '连接被拒' } } })
    fireEvent.click(screen.getByText(zh['action.open']))
    expect(screen.getByText(/连接被拒/)).toBeTruthy()
  })

  it('renders a Host error', () => {
    renderButton({ state: { error: '识别器不可用' } })
    fireEvent.click(screen.getByText(zh['action.open']))
    expect(screen.getByText('识别器不可用')).toBeTruthy()
  })
})

describe('LiveAssistButton while listening', () => {
  it('collapses to a status bar with only pause and stop', () => {
    renderButton({ state: { running: true, connected: true } })
    expect(screen.getByText(zh['state.listening'])).toBeTruthy()
    expect(screen.getByText(zh['action.pause'])).toBeTruthy()
    expect(screen.getByText(zh['action.stop'])).toBeTruthy()
    // The setup surface is gone entirely while a recognizer runs.
    expect(screen.queryByText(zh['action.open'])).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('drives pause and stop through the controller', () => {
    const { mocks } = renderButton({ state: { running: true, connected: true } })
    fireEvent.click(screen.getByText(zh['action.pause']))
    expect(mocks.togglePause).toHaveBeenCalled()
    fireEvent.click(screen.getByText(zh['action.stop']))
    expect(mocks.stop).toHaveBeenCalled()
  })

  it('offers resume once paused', () => {
    renderButton({ state: { running: true, connected: true, paused: true } })
    expect(screen.getByText(zh['state.paused'])).toBeTruthy()
    expect(screen.getByText(zh['action.resume'])).toBeTruthy()
  })

  it('re-renders when the controller reports the counterpart speaking', () => {
    const { controller, set } = stub({ running: true, connected: true })
    const props = {
      t, sessionId: 'session-b' as SessionId, controller, startSession: vi.fn(), isBlankSession: () => false,
    } as unknown as ComponentProps<typeof LiveAssistButton>
    render(<LiveAssistButton {...props} />)
    expect(screen.getByText(zh['state.listening'])).toBeTruthy()
    act(() => { set({ speaking: true }) })
    expect(screen.getByText(zh['state.speaking'])).toBeTruthy()
  })
})

describe('LiveAssistButton session handoff', () => {
  it('adopts a pending start when it mounts in the new session', () => {
    const { controller, mocks } = stub({ running: true })
    Object.defineProperty(controller, 'awaiting', { value: true })
    const props = {
      t, sessionId: 'session-b' as SessionId, controller, startSession: vi.fn(), isBlankSession: () => false,
    } as unknown as ComponentProps<typeof LiveAssistButton>
    render(<LiveAssistButton {...props} />)
    expect(mocks.adopt).toHaveBeenCalledWith('session-b')
  })

  it('does not adopt when nothing is pending', () => {
    const { mocks } = renderButton({ state: { running: false } })
    expect(mocks.adopt).not.toHaveBeenCalled()
  })
})

describe('ExchangeCard', () => {
  function renderCard(data: Record<string, unknown>) {
    const props = { t, node: { data } } as unknown as ComponentProps<typeof ExchangeCard>
    render(<ExchangeCard {...props} />)
  }

  it('shows the question with how much speech it came from', () => {
    renderCard({ question: '讲讲你的项目', seconds: 2.54, answer: '', status: 'pending' })
    expect(screen.getByText('讲讲你的项目')).toBeTruthy()
    expect(screen.getByText(t('exchange.heard', { seconds: '2.5' }))).toBeTruthy()
  })

  it('shows a thinking placeholder until the first delta', () => {
    renderCard({ question: '你好', seconds: 1, answer: '', status: 'streaming' })
    expect(screen.getByText(zh['state.thinking'])).toBeTruthy()
  })

  it('shows the answer once it has text', () => {
    renderCard({ question: '你会 Rust 吗', seconds: 1, answer: '会，写过两年。', status: 'done' })
    expect(screen.getByText('会，写过两年。')).toBeTruthy()
  })

  it('marks an utterance that needed no answer', () => {
    renderCard({ question: '嗯好的', seconds: 1, answer: '', status: 'skipped', reason: 'not-a-question' })
    expect(screen.getByText(zh['answer.skipped'])).toBeTruthy()
  })
})

describe('LiveAssistButton storage and dismissal', () => {
  it('starts with an empty field when storage is denied', () => {
    const getItem = vi.spyOn(window.localStorage.__proto__ as Storage, 'getItem')
      .mockImplementation(() => { throw new Error('storage denied') })
    try {
      renderButton()
      fireEvent.click(screen.getByText(zh['action.open']))
      expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('')
    } finally {
      getItem.mockRestore()
    }
  })

  it('still starts when the background cannot be stored', async () => {
    const setItem = vi.spyOn(window.localStorage.__proto__ as Storage, 'setItem')
      .mockImplementation(() => { throw new Error('storage full') })
    try {
      const startSession = vi.fn()
      renderButton({ startSession })
      fireEvent.click(screen.getByText(zh['action.open']))
      fireEvent.click(screen.getByText(zh['action.start']))
      await waitFor(() => { expect(startSession).toHaveBeenCalled() })
    } finally {
      setItem.mockRestore()
    }
  })

  it('renders a share failure with its detail', () => {
    renderButton({ state: { failure: { key: 'share', message: '用户取消' } } })
    fireEvent.click(screen.getByText(zh['action.open']))
    expect(screen.getByText(/用户取消/)).toBeTruthy()
  })

  it('closes the dialog without starting', () => {
    const startSession = vi.fn()
    renderButton({ startSession })
    fireEvent.click(screen.getByText(zh['action.open']))
    fireEvent.click(screen.getByLabelText(zh['action.close']))
    expect(screen.queryByText(zh['dialog.title'])).toBeNull()
    expect(startSession).not.toHaveBeenCalled()
  })
})
