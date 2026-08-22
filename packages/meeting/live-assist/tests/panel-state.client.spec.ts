// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../src/protocol.ts'
import { INITIAL_PANEL_STATE, parseServerMessage, reducePanel } from '../src/client/panel-state.ts'

describe('reducePanel', () => {
  it('marks the panel connected and clears an earlier error on ready', () => {
    const errored = reducePanel(INITIAL_PANEL_STATE, { type: 'error', message: 'boom', fatal: false })
    const state = reducePanel(errored, { type: 'ready', recognizer: 'live-1' as never })
    expect(state.connected).toBe(true)
    expect('error' in state).toBe(false)
  })

  it('tracks who is speaking', () => {
    const speaking = reducePanel(INITIAL_PANEL_STATE, { type: 'speech', speaking: true })
    expect(speaking.speaking).toBe(true)
    expect(reducePanel(speaking, { type: 'speech', speaking: false }).speaking).toBe(false)
  })

  it('disconnects only on a fatal error', () => {
    const ready = reducePanel(INITIAL_PANEL_STATE, { type: 'ready', recognizer: 'live-1' as never })
    expect(reducePanel(ready, { type: 'error', message: 'x', fatal: false }).connected).toBe(true)
    expect(reducePanel(ready, { type: 'error', message: 'x', fatal: true }).connected).toBe(false)
  })

  it('returns the same state for a message it does not know', () => {
    const unknown = { type: 'invented' } as unknown as ServerMessage
    expect(reducePanel(INITIAL_PANEL_STATE, unknown)).toBe(INITIAL_PANEL_STATE)
  })
})

describe('parseServerMessage', () => {
  it('accepts a tagged object', () => {
    expect(parseServerMessage('{"type":"speech","speaking":true}')).toEqual({ type: 'speech', speaking: true })
  })

  it.each([
    ['not json', 'oops'],
    ['a JSON array', '[1,2]'],
    ['a JSON null', 'null'],
    ['an object with no type', '{"speaking":true}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseServerMessage(raw)).toBeUndefined()
  })
})
