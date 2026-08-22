import { describe, expect, it } from 'vitest'
import { generateAnswer, type AnswerEvent } from '../src/answer.ts'
import { resolveConfig } from '../src/config.ts'

/** `Config` names both the interface and its schemastery value; the parameter type is unambiguous. */
type ConfigInput = Parameters<typeof resolveConfig>[0]
import { llmContext, type Script } from './support/fake-llm.ts'
import { modelDirectory } from './support/model-directory.ts'

async function collect(scripts: readonly Script[], overrides: ConfigInput = {}) {
  const config = resolveConfig(Object.assign({ localModelPath: await modelDirectory() }, overrides))
  const { ctx, requests } = llmContext(scripts)
  const events: AnswerEvent[] = []
  const stream = generateAnswer(
    ctx,
    config,
    { background: '五年 Go 经验', history: [], notes: [], question: '讲讲你的分布式经验' },
    AbortSignal.timeout(5_000),
  )
  for await (const event of stream) events.push(event)
  return { events, requests }
}

describe('generateAnswer', () => {
  it('streams an answer after the control line', async () => {
    const { events } = await collect([{ deltas: ['ANSWER\n', '做过分布式调度。', '\n- 三年'] }])
    expect(events).toEqual([
      { kind: 'start' },
      { kind: 'delta', text: '做过分布式调度。' },
      { kind: 'delta', text: '\n- 三年' },
    ])
  })

  it('reports a skip and stops reading', async () => {
    const { events } = await collect([{ deltas: ['SKIP\n', '不该出现'] }])
    expect(events).toEqual([{ kind: 'skip' }])
  })

  it('skips when the model produced nothing at all', async () => {
    const { events } = await collect([{ deltas: [] }])
    expect(events).toEqual([{ kind: 'skip' }])
  })

  it('answers when the stream ended without a newline', async () => {
    const { events } = await collect([{ deltas: ['很短的回答'] }])
    expect(events).toEqual([
      { kind: 'start' },
      { kind: 'delta', text: '很短的回答' },
    ])
  })

  it('keeps a truncated answer when the token cap was reached', async () => {
    const { events } = await collect([{ deltas: ['ANSWER\n', '讲到一半'], finish: { kind: 'max-tokens' } }])
    expect(events).toEqual([{ kind: 'start' }, { kind: 'delta', text: '讲到一半' }])
  })

  it('sends the background and history to the model', async () => {
    const config = resolveConfig({ localModelPath: await modelDirectory() })
    const { ctx, requests } = llmContext([{ deltas: ['ANSWER\n好的'] }])
    const stream = generateAnswer(
      ctx,
      config,
      {
        background: '五年 Go 经验',
        history: [{ question: '你是谁', answer: '我是候选人' }],
        notes: ['重点讲调度'],
        question: '讲讲分布式',
      },
      AbortSignal.timeout(5_000),
    )
    for await (const _event of stream) { /* drained for its side effect on `requests` */ }
    const sent = requests[0]
    const content = sent?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('五年 Go 经验')
    expect(text).toContain('我是候选人')
    expect(text).toContain('讲讲分布式')
    expect(sent?.system).toContain('SKIP')
  })

  it('honours an explicit answer route', async () => {
    const { requests } = await collect(
      [{ deltas: ['ANSWER\n好'] }],
      { answerProvider: 'deepseek', answerModel: 'deepseek-chat' },
    )
    expect(requests[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('falls back to the default agent route', async () => {
    const { requests } = await collect([{ deltas: ['ANSWER\n好'] }])
    expect(requests[0]).toMatchObject({ provider: 'fake', model: 'fake-model' })
  })

  it.each([
    ['an error finish', { kind: 'error', failure: { message: '上游拒绝', code: 'upstream' } }, /上游拒绝/],
    ['an aborted finish', { kind: 'aborted', failure: { message: '已取消', code: 'aborted' } }, /已取消/],
    ['a tool-call finish', { kind: 'tool-calls' }, /unexpectedly requested a tool/],
    ['an unknown finish', { kind: 'invented' }, /unsupported answer finish reason/],
  ])('raises on %s', async (_label, finish, expected) => {
    await expect(collect([{ deltas: ['ANSWER\n正文'], finish: finish as never }])).rejects.toThrow(expected)
  })

  it('raises when the stream ended with no finish chunk', async () => {
    await expect(collect([{ deltas: ['ANSWER\n正文'], omitFinish: true }]))
      .rejects.toThrow(/without a finish reason/)
  })

  it('propagates a transport failure', async () => {
    await expect(collect([{ deltas: [], throws: new Error('socket reset') }]))
      .rejects.toThrow(/socket reset/)
  })
})

describe('generateAnswer stream handling', () => {
  it('ignores non-text chunks in the stream', async () => {
    const { events } = await collect([{ deltas: ['ANSWER\n正文'], withBlockFraming: true }])
    expect(events).toEqual([{ kind: 'start' }, { kind: 'delta', text: '正文' }])
  })

  it('forwards the default route reasoning effort', async () => {
    const { requests } = await collect([{ deltas: ['ANSWER\n好'], reasoningEffort: 'high' }])
    expect(requests[0]).toMatchObject({ reasoningEffort: 'high' })
  })
})
