// @vitest-environment jsdom

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { UtteranceId } from '../src/protocol.ts'
import { EXCHANGE_KIND, exchangeDefinition, type ExchangeChatData } from '../src/client/exchange-definition.ts'

const first = UtteranceId('u-1')

function event(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

function match(type: string, data: unknown, role: 'start' | 'update' = 'update') {
  return { event: event(type, data), role, location: { kind: 'session' as const } } as never
}

/** Drive the definition from a start event through the given updates. */
function fold(updates: readonly { readonly type: string; readonly data: unknown }[]): ExchangeChatData {
  const start = match('live-assist/utterance', { id: first, text: '讲讲你的项目', seconds: 2.5 }, 'start')
  let state = exchangeDefinition.start({} as never, start, {} as never)
  for (const update of updates) {
    state = exchangeDefinition.update({ state } as never, match(update.type, update.data))
  }
  return state
}

describe('exchangeDefinition', () => {
  it('claims the utterance as a start and its answer events as updates', () => {
    expect(exchangeDefinition.match(event('live-assist/utterance', { id: first })))
      .toEqual({ id: 'u-1', role: 'start' })
    for (const type of ['live-assist/answer-start', 'live-assist/answer-delta', 'live-assist/answer-end', 'live-assist/skipped']) {
      expect(exchangeDefinition.match(event(type, { id: first }))).toEqual({ id: 'u-1', role: 'update' })
    }
  })

  it('ignores events belonging to other plugins', () => {
    expect(exchangeDefinition.match(event('turn/start', { turn: 1 }))).toBeNull()
  })

  it('opens the exchange with the transcript and neither track answered', () => {
    expect(fold([])).toEqual({
      question: '讲讲你的项目',
      seconds: 2.5,
      fast: { text: '', status: 'pending' },
    })
  })

  it('refuses to start on anything but an utterance', () => {
    expect(() => exchangeDefinition.start({} as never, match('live-assist/answer-start', { id: first, track: 'fast' }), {} as never))
      .toThrow(/requires live-assist\/utterance/)
  })

  it('accumulates deltas in order and settles on answer-end', () => {
    const state = fold([
      { type: 'live-assist/answer-start', data: { id: first, track: 'fast' } },
      { type: 'live-assist/answer-delta', data: { id: first, track: 'fast', text: '做过' } },
      { type: 'live-assist/answer-delta', data: { id: first, track: 'fast', text: '三年调度。' } },
      { type: 'live-assist/answer-end', data: { id: first, track: 'fast' } },
    ])
    expect(state).toMatchObject({ fast: { text: '做过三年调度。', status: 'done' } })
  })

  it('grows the deep track only once the Host starts it', () => {
    expect(fold([])).not.toHaveProperty('deep')
    const state = fold([{ type: 'live-assist/answer-start', data: { id: first, track: 'deep' } }])
    expect(state.deep).toEqual({ text: '', status: 'pending' })
  })

  it('keeps the two tracks apart', () => {
    const state = fold([
      { type: 'live-assist/answer-start', data: { id: first, track: 'fast' } },
      { type: 'live-assist/answer-delta', data: { id: first, track: 'fast', text: '会，写过两年。' } },
      { type: 'live-assist/answer-start', data: { id: first, track: 'deep' } },
      { type: 'live-assist/answer-delta', data: { id: first, track: 'deep', text: '直接回答：' } },
      { type: 'live-assist/answer-end', data: { id: first, track: 'fast' } },
      { type: 'live-assist/answer-delta', data: { id: first, track: 'deep', text: '会。原理：…' } },
      { type: 'live-assist/answer-end', data: { id: first, track: 'deep' } },
    ])
    expect(state).toMatchObject({
      fast: { text: '会，写过两年。', status: 'done' },
      deep: { text: '直接回答：会。原理：…', status: 'done' },
    })
  })

  it('records a skip with its reason, leaving both tracks unanswered', () => {
    const state = fold([{ type: 'live-assist/skipped', data: { id: first, reason: 'not-a-question' } }])
    expect(state).toMatchObject({ skipped: 'not-a-question', fast: { text: '', status: 'pending' } })
  })

  it('keeps the state unchanged for an unrelated update', () => {
    const before = fold([])
    const after = exchangeDefinition.update({ state: before } as never, match('turn/end', {}))
    expect(after).toBe(before)
  })

  it('builds a visible chat node anchored at the transcript', () => {
    const start = match('live-assist/utterance', { id: first, text: '你好', seconds: 1 }, 'start')
    const state = exchangeDefinition.start({} as never, start, {} as never)
    const node = exchangeDefinition.buildViewNode?.({
      key: 'k', id: 'u-1', kind: EXCHANGE_KIND, start, state, matches: [], current: new Map(),
    })
    expect(node).toMatchObject({ kind: EXCHANGE_KIND, target: 'chat', visibility: 'visible', anchorSeq: 1 })
  })

  it('builds nothing before a start has been seen', () => {
    expect(exchangeDefinition.buildViewNode?.({
      key: 'k', id: 'u-1', kind: EXCHANGE_KIND, start: undefined, state: undefined, matches: [], current: new Map(),
    })).toBeNull()
  })
})
