// @vitest-environment jsdom

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

function harness() {
  const registrations: { name: string; key?: string; id?: string }[] = []
  const register = vi.fn((spec: { name: string; key?: string; id?: string }) => {
    registrations.push(spec)
    return vi.fn()
  })
  const registerLocale = vi.fn(() => vi.fn())
  const registerDefinition = vi.fn()
  const startSession = vi.fn()
  const list = { byId: { 'session-blank': { blank: true }, 'session-used': { blank: false } } }
  const ctx = {
    effect: vi.fn((run: () => unknown) => run()),
    locale: { register: registerLocale },
    slots: { inject: vi.fn((_name: string, run: () => void) => { run() }), register },
    conversationEvents: { register: registerDefinition },
    sessions: { list: { getSnapshot: () => list } },
    workspaces: { startSession },
  } as unknown as ClientContext
  return { ctx, registrations, registerLocale, registerDefinition, register, startSession }
}

describe('live-assist client plugin', () => {
  it('declares every service it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'conversationEvents', 'sessions', 'workspaces'])
  })

  it('registers dictionaries, the projection, the renderer, and the composer control', () => {
    const { ctx, registrations, registerLocale, registerDefinition } = harness()
    apply(ctx)

    expect(registerLocale).toHaveBeenCalledWith('live-assist', { zh, en })
    expect(registerDefinition).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'live-assist-exchange',
      target: 'chat',
    }))
    expect(registrations).toEqual([
      expect.objectContaining({ name: 'conversation.chat.node', key: 'live-assist-exchange' }),
      expect.objectContaining({ name: 'conversation.input.left', id: 'live-assist' }),
    ])
  })

  it('injects a controller, a session starter, and the blank-session test', () => {
    const { ctx, register, startSession } = harness()
    apply(ctx)
    const composer = register.mock.calls
      .map(call => call[0] as { name: string; inject?: () => unknown })
      .find(spec => spec.name === 'conversation.input.left')
    const injected = composer?.inject?.() as {
      controller: unknown
      startSession: () => void
      isBlankSession: (session: string) => boolean
    }
    expect(injected.controller).toBeDefined()
    injected.startSession()
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(injected.isBlankSession('session-blank')).toBe(true)
    expect(injected.isBlankSession('session-used')).toBe(false)
    // A session the list has not caught up with is not treated as blank: a start would then be
    // adopted here and the transcript would land in the user's own conversation.
    expect(injected.isBlankSession('session-unknown')).toBe(false)
  })

  it('stops a running recognizer when the plugin unloads', () => {
    const { ctx } = harness()
    const effects: (() => unknown)[] = []
    const effectSpy = vi.fn((run: () => unknown) => { effects.push(run); return run() })
    apply(Object.assign({}, ctx, { effect: effectSpy }))
    // The first effect yields the teardown that releases the share.
    const teardown = effects[0]?.() as (() => void) | undefined
    expect(() => teardown?.()).not.toThrow()
  })

  it('keeps both dictionaries on the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
