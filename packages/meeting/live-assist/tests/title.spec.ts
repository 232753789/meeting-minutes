import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { generateTitle } from '../src/title.ts'
import { llmContext, type Script } from './support/fake-llm.ts'
import { modelDirectory } from './support/model-directory.ts'

async function title(scripts: readonly Script[], background = '五年 Go 后端，做过分布式调度') {
  const config = resolveConfig({ localModelPath: await modelDirectory() })
  const { ctx, requests } = llmContext(scripts)
  return { result: await generateTitle(ctx, config, background, AbortSignal.timeout(5_000)), requests }
}

describe('generateTitle', () => {
  it('names the session from the background material', async () => {
    const { result } = await title([{ deltas: ['Go 后端·分布式方向'] }])
    expect(result).toBe('Go 后端·分布式方向')
  })

  it('sends the background material and asks for a bare title', async () => {
    const { requests } = await title([{ deltas: ['标题'] }])
    const content = requests[0]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('五年 Go 后端')
    expect(requests[0]?.system).toContain('只输出标题本身')
  })

  it('makes no request at all for empty background material', async () => {
    const { result, requests } = await title([{ deltas: ['未使用'] }], '   ')
    expect(result).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('treats the model\'s "nothing to name" answer as no title', async () => {
    const { result } = await title([{ deltas: ['-'] }])
    expect(result).toBeUndefined()
  })

  it('treats an empty completion as no title', async () => {
    const { result } = await title([{ deltas: [''] }])
    expect(result).toBeUndefined()
  })

  it('flattens newlines and strips surrounding quotes', async () => {
    const { result } = await title([{ deltas: ['「后端面试\n分布式」'] }])
    expect(result).toBe('后端面试 分布式')
  })

  it('caps the request with titleMaxOutputTokens', async () => {
    const { requests } = await title([{ deltas: ['标题'] }])
    expect(requests[0]?.maxTokens).toBe(64)
  })
})

describe('session-log vocabulary', () => {
  it.each([
    'live-assist/utterance',
    'live-assist/answer-start',
    'live-assist/answer-delta',
    'live-assist/answer-end',
    'live-assist/skipped',
  ])('%s is a known event type, so a stored session replays', (type) => {
    // The persistence read path refuses a log carrying a type outside this set, so an interview
    // session is only reloadable while these are registered.
    expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
  })
})
