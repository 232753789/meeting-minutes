// @vitest-environment jsdom

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { BACKGROUND_KIND, backgroundDefinition } from '../src/client/background-definition.ts'

function event(type: string, data: unknown, seq = 7): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

function match(type: string, data: unknown, role: 'start' | 'update' = 'start', seq = 7) {
  return { event: event(type, data, seq), role, location: { kind: 'session' as const } } as never
}

describe('backgroundDefinition', () => {
  it('claims each listening run by the opener that started it', () => {
    expect(backgroundDefinition.match(event('live-assist/started', { background: '五年 Go' }, 7)))
      .toEqual({ id: '7', role: 'start' })
    // A second run in the same session gets its own node rather than replacing the first.
    expect(backgroundDefinition.match(event('live-assist/started', { background: '换个岗位' }, 42)))
      .toEqual({ id: '42', role: 'start' })
  })

  it('ignores events belonging to other plugins', () => {
    expect(backgroundDefinition.match(event('turn/start', { turn: 1 }))).toBeNull()
  })

  it('carries the material verbatim', () => {
    const material = '五年 Go\n做过信贷风控，想强调实时决策引擎。'
    const state = backgroundDefinition.start({} as never, match('live-assist/started', { background: material }), {} as never)
    expect(state).toEqual({ background: material })
  })

  it('refuses to start on anything but the opener', () => {
    expect(() => backgroundDefinition.start({} as never, match('live-assist/utterance', { text: '你好' }), {} as never))
      .toThrow(/requires live-assist\/started/)
  })

  it('keeps the material unchanged for any later event', () => {
    const before = backgroundDefinition.start({} as never, match('live-assist/started', { background: '简历' }), {} as never)
    expect(backgroundDefinition.update({ state: before } as never, match('turn/end', {}, 'update'))).toBe(before)
  })

  it('builds a visible chat node anchored at the opener', () => {
    const start = match('live-assist/started', { background: '简历' })
    const state = backgroundDefinition.start({} as never, start, {} as never)
    const node = backgroundDefinition.buildViewNode?.({
      key: 'k', id: '7', kind: BACKGROUND_KIND, start, state, matches: [], current: new Map(),
    })
    expect(node).toMatchObject({ kind: BACKGROUND_KIND, target: 'chat', visibility: 'visible', anchorSeq: 7 })
  })

  it('builds nothing before a start has been seen', () => {
    expect(backgroundDefinition.buildViewNode?.({
      key: 'k', id: '7', kind: BACKGROUND_KIND, start: undefined, state: undefined, matches: [], current: new Map(),
    })).toBeNull()
  })
})
