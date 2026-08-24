// @vitest-environment jsdom

import { useState, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, getDefaultNormalizer, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MissingSystemAudioError } from '../src/client/audio-capture.ts'
import { BackgroundCard } from '../src/client/BackgroundCard.tsx'
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
  const mocks = { start: vi.fn(), stop: vi.fn(), togglePause: vi.fn() }
  return {
    mocks,
    controller: {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      getState: () => current,
      ...mocks,
    } as unknown as LiveAssistController,
    set: (next: Partial<ControllerState>) => {
      current = { ...current, ...next }
      for (const listener of listeners) listener()
    },
  }
}

/** The drawer's half of the tool contract: it, not the entry, holds the open flag. */
function seat(overrides: {
  state?: Partial<ControllerState>
  sessionId?: SessionId
  blank?: boolean
  surface?: 'bar' | 'drawer'
  setOpen?: (open: boolean) => void
} = {}) {
  const { controller, mocks } = stub(overrides.state ?? {})
  function Host() {
    const [open, setOpen] = useState(false)
    const props = {
      t,
      sessionId: overrides.sessionId ?? ('session-a' as SessionId),
      surface: overrides.surface ?? 'bar',
      open,
      setOpen: overrides.setOpen ?? setOpen,
      controller,
      isBlankSession: () => overrides.blank ?? false,
    } as unknown as ComponentProps<typeof LiveAssistButton>
    return <LiveAssistButton {...props} />
  }
  return { controller, mocks, Host }
}

function renderButton(overrides: Parameters<typeof seat>[0] = {}) {
  const { controller, mocks, Host } = seat(overrides)
  render(<Host />)
  return { controller, mocks }
}

/** Click the tool row's icon, which is what the drawer leaves visible when closed. */
function openDialog(): void {
  fireEvent.click(screen.getByLabelText(zh['action.open']))
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
  it('opens a setup dialog explaining where the interview lands', () => {
    renderButton()
    openDialog()
    expect(screen.getByText(zh['hint.newSession'])).toBeTruthy()
    expect(screen.getByText(zh['hint.screenShare'])).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
    // Nothing to warn about: this session already holds a conversation.
    expect(screen.queryByText(zh['hint.blankSession'])).toBeNull()
  })

  it('warns that a blank session will not stay in the list', () => {
    renderButton({ blank: true })
    openDialog()
    expect(screen.getByText(zh['hint.blankSession'])).toBeTruthy()
  })

  it('listens in the session it is already in, opening no other', async () => {
    const { mocks } = renderButton({ sessionId: 'session-a' as SessionId })
    openDialog()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '五年 Go' } })
    fireEvent.click(screen.getByText(zh['action.start']))

    // The share must be obtained inside the click, before anything is awaited.
    await waitFor(() => { expect(mocks.start).toHaveBeenCalled() })
    expect(mocks.start).toHaveBeenCalledWith('五年 Go', 'session-a', expect.anything())
    expect(screen.queryByText(zh['dialog.title'])).toBeNull()
    expect(window.localStorage.getItem('dsh.live-assist.background')).toBe('五年 Go')
  })

  it('reports a refused share and starts nothing', async () => {
    shareProbe.failWith = new Error('用户取消了共享')
    const { mocks } = renderButton()
    openDialog()
    fireEvent.click(screen.getByText(zh['action.start']))
    await waitFor(() => { expect(screen.getByText(/用户取消了共享/)).toBeTruthy() })
    expect(mocks.start).not.toHaveBeenCalled()
    // The dialog stays open so the user can simply try again.
    expect(screen.getByText(zh['dialog.title'])).toBeTruthy()
  })

  it('stringifies a non-Error share refusal', async () => {
    shareProbe.failWith = '系统策略阻止了屏幕共享'
    renderButton()
    openDialog()
    fireEvent.click(screen.getByText(zh['action.start']))
    await waitFor(() => { expect(screen.getByText(/系统策略阻止了屏幕共享/)).toBeTruthy() })
  })

  it('reports a share that carried no audio', async () => {
    shareProbe.failWith = new MissingSystemAudioError()
    renderButton()
    openDialog()
    fireEvent.click(screen.getByText(zh['action.start']))
    await waitFor(() => { expect(screen.getByText(zh['error.missingAudio'])).toBeTruthy() })
  })

  it('renders a capture failure the controller reported', () => {
    renderButton({ state: { failure: { key: 'missingAudio', message: '' } } })
    openDialog()
    expect(screen.getByText(zh['error.missingAudio'])).toBeTruthy()
  })

  it('renders a socket failure with its detail', () => {
    renderButton({ state: { failure: { key: 'socket', message: '连接被拒' } } })
    openDialog()
    expect(screen.getByText(/连接被拒/)).toBeTruthy()
  })

  it('renders a Host error', () => {
    renderButton({ state: { error: '识别器不可用' } })
    openDialog()
    expect(screen.getByText('识别器不可用')).toBeTruthy()
  })
})

describe('LiveAssistButton in the tool drawer', () => {
  it('names the tool and says what it does', () => {
    const setOpen = vi.fn()
    renderButton({ surface: 'drawer', setOpen })
    expect(screen.getByText(zh['action.open'])).toBeTruthy()
    expect(screen.getByText(zh['tool.description'])).toBeTruthy()
    // The setup dialog belongs to the bar surface, which outlives the panel.
    expect(screen.queryByText(zh['dialog.title'])).toBeNull()

    fireEvent.click(screen.getByText(zh['action.open']))
    expect(setOpen).toHaveBeenCalledWith(true)
  })

  it('reports the run in place of an action while listening', () => {
    const setOpen = vi.fn()
    renderButton({ surface: 'drawer', setOpen, state: { running: true, connected: true } })
    expect(screen.getByText(zh['state.listening'])).toBeTruthy()
    fireEvent.click(screen.getByText(zh['action.open']))
    // Pause and stop live on the bar surface; the row must not reopen setup over a live run.
    expect(setOpen).not.toHaveBeenCalled()
  })
})

describe('LiveAssistButton while listening', () => {
  it('collapses to a status bar with only pause and stop', () => {
    renderButton({ state: { running: true, connected: true } })
    expect(screen.getByText(zh['state.listening'])).toBeTruthy()
    expect(screen.getByText(zh['action.pause'])).toBeTruthy()
    expect(screen.getByText(zh['action.stop'])).toBeTruthy()
    // The setup surface is gone entirely while a recognizer runs.
    expect(screen.queryByLabelText(zh['action.open'])).toBeNull()
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
      t,
      sessionId: 'session-b' as SessionId,
      surface: 'bar',
      open: false,
      setOpen: () => {},
      controller,
      isBlankSession: () => false,
    } as unknown as ComponentProps<typeof LiveAssistButton>
    render(<LiveAssistButton {...props} />)
    expect(screen.getByText(zh['state.listening'])).toBeTruthy()
    act(() => { set({ speaking: true }) })
    expect(screen.getByText(zh['state.speaking'])).toBeTruthy()
  })
})

describe('LiveAssistButton across a session switch', () => {
  it('keeps rendering the running bar after remounting in another session', () => {
    const { controller, mocks } = stub({ running: true, connected: true })
    const props = {
      t,
      sessionId: 'session-b' as SessionId,
      surface: 'bar',
      open: false,
      setOpen: () => {},
      controller,
      isBlankSession: () => false,
    } as unknown as ComponentProps<typeof LiveAssistButton>
    render(<LiveAssistButton {...props} />)
    // The run lives in the controller, so a remount neither restarts nor drops it.
    expect(screen.getByText(zh['state.listening'])).toBeTruthy()
    expect(mocks.start).not.toHaveBeenCalled()
  })
})

describe('BackgroundCard', () => {
  function renderCard(background: string) {
    const props = { t, node: { data: { background } } } as unknown as ComponentProps<typeof BackgroundCard>
    render(<BackgroundCard {...props} />)
  }

  it('shows the material in full, exactly as the answer requests carry it', () => {
    const material = '五年 Go\n做过信贷风控，想强调实时决策引擎。'
    renderCard(material)
    expect(screen.getByText(zh['background.title'])).toBeTruthy()
    // Matched without collapsing whitespace: the line break the interviewee typed is still there.
    expect(screen.getByText(material, { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) }))
      .toBeTruthy()
  })

  it('says so when the run was started without material', () => {
    renderCard('   ')
    expect(screen.getByText(zh['background.empty'])).toBeTruthy()
  })
})

describe('ExchangeCard', () => {
  function renderCard(data: Record<string, unknown>) {
    const props = { t, node: { data } } as unknown as ComponentProps<typeof ExchangeCard>
    render(<ExchangeCard {...props} />)
  }

  const PENDING = { text: '', status: 'pending' }

  it('shows the question with how much speech it came from', () => {
    renderCard({ question: '讲讲你的项目', seconds: 2.54, fast: PENDING })
    expect(screen.getByText('讲讲你的项目')).toBeTruthy()
    expect(screen.getByText(t('exchange.heard', { seconds: '2.5' }))).toBeTruthy()
  })

  it('shows a thinking placeholder until the first delta', () => {
    renderCard({ question: '你好', seconds: 1, fast: { text: '', status: 'streaming' } })
    expect(screen.getByText(zh['state.thinking'])).toBeTruthy()
  })

  it('shows the answer once it has text', () => {
    renderCard({ question: '你会 Rust 吗', seconds: 1, fast: { text: '会，写过两年。', status: 'done' } })
    expect(screen.getByText('会，写过两年。')).toBeTruthy()
  })

  it('labels neither track when the Host runs the fast one alone', () => {
    renderCard({ question: '你会 Rust 吗', seconds: 1, fast: { text: '会。', status: 'done' } })
    expect(screen.queryByText(zh['answer.fast'])).toBeNull()
    expect(screen.queryByText(zh['answer.deep'])).toBeNull()
  })

  it('stacks the detailed answer under the short one, each labelled', () => {
    renderCard({
      question: '你会 Rust 吗',
      seconds: 1,
      fast: { text: '会，写过两年。', status: 'done' },
      deep: { text: '直接回答：会。', status: 'streaming' },
    })
    expect(screen.getByText(zh['answer.fast'])).toBeTruthy()
    expect(screen.getByText(zh['answer.deep'])).toBeTruthy()
    expect(screen.getByText('会，写过两年。')).toBeTruthy()
    expect(screen.getByText('直接回答：会。')).toBeTruthy()
  })

  it('shows its own placeholder while the detailed answer is still being written', () => {
    renderCard({
      question: '你会 Rust 吗',
      seconds: 1,
      fast: { text: '会，写过两年。', status: 'done' },
      deep: PENDING,
    })
    expect(screen.getByText(zh['state.thinkingDeep'])).toBeTruthy()
  })

  it('marks an utterance that needed no answer', () => {
    renderCard({ question: '嗯好的', seconds: 1, fast: PENDING, skipped: 'not-a-question' })
    expect(screen.getByText(zh['answer.skipped'])).toBeTruthy()
  })

  it('shows no answer at all for a skipped utterance', () => {
    renderCard({
      question: '嗯好的',
      seconds: 1,
      fast: { text: '不该出现', status: 'done' },
      skipped: 'not-a-question',
    })
    expect(screen.queryByText('不该出现')).toBeNull()
  })
})

describe('LiveAssistButton storage and dismissal', () => {
  it('starts with an empty field when storage is denied', () => {
    const getItem = vi.spyOn(window.localStorage.__proto__ as Storage, 'getItem')
      .mockImplementation(() => { throw new Error('storage denied') })
    try {
      renderButton()
      openDialog()
      expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('')
    } finally {
      getItem.mockRestore()
    }
  })

  it('still starts when the background cannot be stored', async () => {
    const setItem = vi.spyOn(window.localStorage.__proto__ as Storage, 'setItem')
      .mockImplementation(() => { throw new Error('storage full') })
    try {
      const { mocks } = renderButton()
      openDialog()
      fireEvent.click(screen.getByText(zh['action.start']))
      await waitFor(() => { expect(mocks.start).toHaveBeenCalled() })
    } finally {
      setItem.mockRestore()
    }
  })

  it('renders a share failure with its detail', () => {
    renderButton({ state: { failure: { key: 'share', message: '用户取消' } } })
    openDialog()
    expect(screen.getByText(/用户取消/)).toBeTruthy()
  })

  it('closes the dialog without starting', () => {
    const { mocks } = renderButton()
    openDialog()
    fireEvent.click(screen.getByLabelText(zh['action.close']))
    expect(screen.queryByText(zh['dialog.title'])).toBeNull()
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
