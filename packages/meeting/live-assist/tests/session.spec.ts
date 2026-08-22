import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'

/** `Config` names both the interface and its schemastery value; the parameter type is unambiguous. */
type ConfigInput = Parameters<typeof resolveConfig>[0]
import { LiveSessionId, type ServerMessage } from '../src/protocol.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { intervieweeNotes, LiveSession } from '../src/session.ts'
import type { LiveAsrWorker, WorkerListener } from '../src/worker.ts'
import { llmContext, type Script } from './support/fake-llm.ts'
import { modelDirectory } from './support/model-directory.ts'

class FakeWorker {
  listener: WorkerListener | undefined
  readonly frames: Buffer[] = []
  readonly closed: string[] = []

  open(_session: string, listener: WorkerListener): Promise<void> {
    this.listener = listener
    return Promise.resolve()
  }

  push(_session: string, pcm: Buffer): void {
    this.frames.push(pcm)
  }

  close(session: string): void {
    this.closed.push(session)
  }
}

/** Records what the plugin appended to the dsh session, in order. */
class FakeTargetSession {
  readonly appended: { type: string; data: Record<string, unknown> }[] = []
  /** Messages the interviewee typed into this session, as the session log would carry them. */
  events: { type: string; data: unknown }[] = []

  append(type: string, data: Record<string, unknown>): void {
    this.appended.push({ type, data })
  }

  /** Event types only, which is what most assertions care about. */
  get types(): string[] {
    return this.appended.map(entry => entry.type)
  }
}

async function harness(
  scripts: readonly Script[],
  overrides: ConfigInput = {},
  options: { titles?: { rename: (session: unknown, title: string) => void } } = {},
) {
  const config = resolveConfig(Object.assign({ localModelPath: await modelDirectory() }, overrides))
  const { ctx, requests } = llmContext(scripts)
  Object.assign(ctx, { get: (name: string) => (name === 'sessionTitle' ? options.titles : undefined) })
  const worker = new FakeWorker()
  const sent: ServerMessage[] = []
  const target = new FakeTargetSession()
  const session = new LiveSession(
    ctx,
    config,
    worker as unknown as LiveAsrWorker,
    LiveSessionId('s1'),
    message => sent.push(message),
  )
  await session.start('我的背景', target as unknown as Session)
  return { session, worker, sent, requests, target, ctx }
}

function speak(worker: FakeWorker, index: number, text: string): void {
  worker.listener?.({ kind: 'utterance', index, text, seconds: 2 })
}

describe('LiveSession', () => {
  it('answers an utterance and reports every stage', async () => {
    const { session, worker, sent, target } = await harness([{ deltas: ['ANSWER\n', '做过三年。'] }])
    speak(worker, 1, '讲讲你的经验')
    await session.settled()
    expect(target.types).toEqual([
      'live-assist/started',
      'live-assist/utterance',
      'live-assist/answer-start',
      'live-assist/answer-delta',
      'live-assist/answer-end',
    ])
    // The socket carries live status only; the exchange itself lives in the session log.
    expect(sent.map(message => message.type)).toEqual(['ready'])
    await session.dispose()
  })

  it('passes an answered question into the next request as history', async () => {
    const { session, worker, requests } = await harness([{ deltas: ['ANSWER\n第一答'] }])
    speak(worker, 1, '第一问')
    await session.settled()
    speak(worker, 2, '第二问')
    await session.settled()
    const content = requests[1]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('第一问')
    expect(text).toContain('第一答')
    await session.dispose()
  })

  it('keeps a skipped utterance out of history', async () => {
    const { session, worker, requests } = await harness([{ deltas: ['SKIP\n'] }, { deltas: ['ANSWER\n答'] }])
    speak(worker, 1, '嗯好的对')
    await session.settled()
    speak(worker, 2, '第二问')
    await session.settled()
    const content = requests[1]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('"已回答过的问题":[]')
    await session.dispose()
  })

  it('bounds retained history', async () => {
    const { session, worker, requests } = await harness([{ deltas: ['ANSWER\n答'] }], { historyTurns: 1 })
    speak(worker, 1, '第一问')
    await session.settled()
    speak(worker, 2, '第二问')
    await session.settled()
    speak(worker, 3, '第三问')
    await session.settled()
    const content = requests[2]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('第二问')
    expect(text).not.toContain('第一问')
    await session.dispose()
  })

  it('reports an empty transcript without calling the model', async () => {
    const { session, worker, requests, target } = await harness([{ deltas: ['ANSWER\n答'] }])
    speak(worker, 1, '   ')
    await session.settled()
    expect(target.appended.at(-1)).toMatchObject({
      type: 'live-assist/skipped',
      data: { reason: 'empty-transcript' },
    })
    expect(requests).toHaveLength(0)
    await session.dispose()
  })

  it('reports a filler-length transcript without calling the model', async () => {
    const { session, worker, requests, target } = await harness([{ deltas: ['ANSWER\n答'] }])
    speak(worker, 1, '嗯')
    await session.settled()
    expect(target.appended.at(-1)).toMatchObject({
      type: 'live-assist/skipped',
      data: { reason: 'too-short' },
    })
    expect(requests).toHaveLength(0)
    await session.dispose()
  })

  it('reports the model judging an utterance to need no answer', async () => {
    const { session, worker, target } = await harness([{ deltas: ['SKIP\n'] }])
    speak(worker, 1, '我们公司成立于两千年')
    await session.settled()
    expect(target.appended.at(-1)).toMatchObject({
      type: 'live-assist/skipped',
      data: { reason: 'not-a-question' },
    })
    await session.dispose()
  })

  it('answers every utterance, even when the next one arrives first', async () => {
    const { session, worker, target } = await harness([{ deltas: ['ANSWER\n第一答'] }, { deltas: ['ANSWER\n第二答'] }])
    speak(worker, 1, '第一问')
    speak(worker, 2, '第二问')
    await session.settled()
    expect(target.types.filter(type => type === 'live-assist/answer-end')).toHaveLength(2)
    expect(target.appended.filter(entry => entry.type === 'live-assist/answer-delta'))
      .toEqual([
        { type: 'live-assist/answer-delta', data: { id: 's1-1', text: '第一答' } },
        { type: 'live-assist/answer-delta', data: { id: 's1-2', text: '第二答' } },
      ])
    await session.dispose()
  })

  it('keeps answers in the order the questions were heard', async () => {
    const { session, worker, target } = await harness([
      { deltas: ['ANSWER\n答一'] },
      { deltas: ['ANSWER\n答二'] },
      { deltas: ['ANSWER\n答三'] },
    ])
    speak(worker, 1, '问一')
    speak(worker, 2, '问二')
    speak(worker, 3, '问三')
    await session.settled()
    expect(target.appended
      .filter(entry => entry.type === 'live-assist/answer-start')
      .map(entry => entry.data.id))
      .toEqual(['s1-1', 's1-2', 's1-3'])
    await session.dispose()
  })

  it('feeds an earlier answer into the next queued question as history', async () => {
    const { session, worker, requests } = await harness([{ deltas: ['ANSWER\n第一答'] }])
    speak(worker, 1, '第一问')
    speak(worker, 2, '第二问')
    await session.settled()
    const content = requests[1]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('第一答')
    await session.dispose()
  })

  it('forwards speech transitions', async () => {
    const { session, worker, sent } = await harness([{ deltas: ['ANSWER\n答'] }])
    worker.listener?.({ kind: 'speech', speaking: true })
    expect(sent.at(-1)).toEqual({ type: 'speech', speaking: true })
    await session.dispose()
  })

  it('forwards a recognizer failure without ending the session', async () => {
    const { session, worker, sent } = await harness([{ deltas: ['ANSWER\n答'] }])
    worker.listener?.({ kind: 'error', message: '识别失败' })
    expect(sent.at(-1)).toEqual({ type: 'error', message: '识别失败', fatal: false })
    await session.dispose()
  })

  it('reports a model failure to the panel', async () => {
    const { session, worker, sent } = await harness([{ deltas: [], throws: new Error('上游超时') }])
    speak(worker, 1, '讲讲你的经验')
    await session.settled()
    expect(sent.at(-1)).toMatchObject({ type: 'error', message: '上游超时', fatal: false })
    await session.dispose()
  })

  it('forwards audio only while running and unpaused', async () => {
    const { session, worker } = await harness([{ deltas: ['ANSWER\n答'] }])
    session.pushAudio(Buffer.from([1]))
    session.pause()
    session.pushAudio(Buffer.from([2]))
    session.resume()
    session.pushAudio(Buffer.from([3]))
    expect(worker.frames).toHaveLength(2)
    await session.dispose()
    session.pushAudio(Buffer.from([4]))
    expect(worker.frames).toHaveLength(2)
  })

  it('starts at most once', async () => {
    const { session, worker, sent, target } = await harness([{ deltas: ['ANSWER\n答'] }])
    await session.start('再来一次', target as unknown as Session)
    expect(sent.filter(message => message.type === 'ready')).toHaveLength(1)
    expect(worker.frames).toHaveLength(0)
    await session.dispose()
  })

  it('releases the recognizer and silences late events on dispose', async () => {
    const { session, worker, sent } = await harness([{ deltas: ['ANSWER\n答'] }])
    await session.dispose()
    expect(worker.closed).toEqual(['s1'])
    const before = sent.length
    worker.listener?.({ kind: 'speech', speaking: true })
    expect(sent).toHaveLength(before)
  })

  it('does nothing when started after disposal', async () => {
    const { session, sent, target } = await harness([{ deltas: ['ANSWER\n答'] }])
    await session.dispose()
    const before = sent.length
    await session.start('x', target as unknown as Session)
    expect(sent).toHaveLength(before)
  })

  it('drops an answer that finished after the session was disposed', async () => {
    const { session, worker, target } = await harness([{ deltas: ['ANSWER\n慢答'] }])
    speak(worker, 1, '一个问题')
    await session.dispose()
    await vi.waitFor(() => { expect(target.types).not.toContain('live-assist/answer-end') })
  })
})

describe('LiveSession failure handling', () => {
  it('stringifies a non-Error model failure', async () => {
    const { session, worker, sent } = await harness([{ deltas: [], throwsValue: '上游返回了字符串' }])
    speak(worker, 1, '讲讲你的经验')
    await session.settled()
    expect(sent.at(-1)).toMatchObject({ type: 'error', message: '上游返回了字符串' })
    await session.dispose()
  })

})

describe('LiveSession cancellation mid-stream', () => {
  it('stops forwarding deltas as soon as the session is disposed', async () => {
    const config = resolveConfig({ localModelPath: await modelDirectory() })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ctx = {
      logger: { warn: () => {} },
      get: () => undefined,
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
      llm: {
        stream: () => (async function* replay() {
          yield { type: 'text-delta', index: 0, text: 'ANSWER\n第一段' }
          await gate
          yield { type: 'text-delta', index: 0, text: '第二段' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      },
    }
    const worker = new FakeWorker()
    const target = new FakeTargetSession()
    const session = new LiveSession(
      ctx as never,
      config,
      worker as unknown as LiveAsrWorker,
      LiveSessionId('s1'),
      () => {},
    )
    await session.start('', target as unknown as Session)
    speak(worker, 1, '一个问题')
    await vi.waitFor(() => { expect(target.types).toContain('live-assist/answer-delta') })
    const disposal = session.dispose()
    release?.()
    await disposal
    expect(target.types.filter(type => type === 'live-assist/answer-delta')).toHaveLength(1)
    expect(target.types).not.toContain('live-assist/answer-end')
  })
})

describe('LiveSession interruption during delivery', () => {
  it('finishes the answer in flight when the next utterance arrives mid-delivery', async () => {
    const config = resolveConfig({ localModelPath: await modelDirectory() })
    const { ctx } = llmContext([
      { deltas: ['ANSWER\n', '第一段', '第二段', '第三段'] },
      { deltas: ['ANSWER\n新答'] },
    ])
    Object.assign(ctx, { get: () => undefined })
    const worker = new FakeWorker()
    let interrupted = false
    /** Interrupts exactly while the first answer is being written into the session. */
    class InterruptingSession extends FakeTargetSession {
      override append(type: string, data: Record<string, unknown>): void {
        super.append(type, data)
        if (type === 'live-assist/answer-delta' && !interrupted) {
          interrupted = true
          speak(worker, 2, '第二问')
        }
      }
    }
    const target = new InterruptingSession()
    const session = new LiveSession(
      ctx,
      config,
      worker as unknown as LiveAsrWorker,
      LiveSessionId('s1'),
      () => {},
    )
    await session.start('', target as unknown as Session)
    speak(worker, 1, '第一问')
    // `settled()` resolves the queue as it stood when called; the interrupting question is
    // appended to it afterwards, so wait for its own completion rather than one settle.
    await vi.waitFor(() => {
      expect(target.appended.some(entry =>
        entry.type === 'live-assist/answer-end' && entry.data.id === 's1-2')).toBe(true)
    })

    // The recognizer splits on silence, so a mid-sentence pause can end an utterance early.
    // The question that was already being answered must keep its complete answer.
    const first = target.appended.filter(entry =>
      entry.type === 'live-assist/answer-delta' && entry.data.id === 's1-1')
    expect(first.map(entry => entry.data.text)).toEqual(['第一段', '第二段', '第三段'])
    expect(target.appended.some(entry =>
      entry.type === 'live-assist/answer-end' && entry.data.id === 's1-1')).toBe(true)
    // And the utterance that interrupted it is answered in its own right.
    expect(target.appended.some(entry =>
      entry.type === 'live-assist/answer-end' && entry.data.id === 's1-2')).toBe(true)
    await session.dispose()
  })
})

describe('LiveSession session naming', () => {
  it('names the session from the background material', async () => {
    const renamed: string[] = []
    const { session } = await harness(
      [{ deltas: ['Go 后端·分布式'] }],
      {},
      { titles: { rename: (_target, title) => { renamed.push(title) } } },
    )
    await session.settled()
    expect(renamed).toEqual(['Go 后端·分布式'])
    await session.dispose()
  })

  it('starts listening before the title request returns', async () => {
    const { session, sent } = await harness(
      [{ deltas: ['标题'] }],
      {},
      { titles: { rename: () => {} } },
    )
    // `ready` is sent from start(), which never awaits the naming request.
    expect(sent.map(message => message.type)).toEqual(['ready'])
    await session.settled()
    await session.dispose()
  })

  it('leaves the session unnamed when the material yields no title', async () => {
    const renamed: string[] = []
    const config = resolveConfig({ localModelPath: await modelDirectory() })
    const { ctx } = llmContext([{ deltas: ['未使用'] }])
    Object.assign(ctx, {
      logger: { warn: () => {} },
      get: () => ({ rename: (_t: unknown, title: string) => { renamed.push(title) } }),
    })
    const session = new LiveSession(
      ctx,
      config,
      new FakeWorker() as unknown as LiveAsrWorker,
      LiveSessionId('s1'),
      () => {},
    )
    // Empty background material never reaches the model, so there is nothing to name it after.
    await session.start('   ', new FakeTargetSession() as unknown as Session)
    await session.settled()
    expect(renamed).toEqual([])
    await session.dispose()
  })

  it('leaves the session unnamed when no title service is installed', async () => {
    const { session, requests } = await harness([{ deltas: ['标题'] }])
    await session.settled()
    expect(requests).toHaveLength(0)
    await session.dispose()
  })

  it('keeps listening when naming fails', async () => {
    const warned: unknown[] = []
    const { session, worker, target, ctx } = await harness(
      [{ deltas: [], throws: new Error('上游不可用') }, { deltas: ['ANSWER\n答'] }],
      {},
      { titles: { rename: () => { throw new Error('unreachable') } } },
    )
    Object.assign(ctx, { logger: { warn: (value: unknown) => { warned.push(value) } } })
    await session.settled()
    speak(worker, 1, '一个问题')
    await session.settled()
    expect(target.types).toContain('live-assist/answer-end')
    await session.dispose()
  })

  it('logs a non-Error naming failure and keeps listening', async () => {
    const warned: unknown[] = []
    const { session, worker, target, ctx } = await harness(
      [{ deltas: [], throwsValue: '标题服务返回了字符串' }, { deltas: ['ANSWER\n答'] }],
      {},
      { titles: { rename: () => {} } },
    )
    Object.assign(ctx, { logger: { warn: (value: unknown) => { warned.push(value) } } })
    await session.settled()
    speak(worker, 1, '一个问题')
    await session.settled()
    expect(target.types).toContain('live-assist/answer-end')
    await session.dispose()
  })

  it('does not rename a session whose start was already disposed', async () => {
    const renamed: string[] = []
    const { session } = await harness(
      [{ deltas: ['标题'] }],
      {},
      { titles: { rename: (_target, title) => { renamed.push(title) } } },
    )
    await session.dispose()
    expect(renamed).toEqual([])
  })
})

describe('LiveSession naming raced against disposal', () => {
  it('drops a title that finished generating after the session ended', async () => {
    const config = resolveConfig({ localModelPath: await modelDirectory() })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const renamed: string[] = []
    const warned: unknown[] = []
    const ctx = {
      logger: { warn: (value: unknown) => { warned.push(value) } },
      get: (name: string) => (name === 'sessionTitle'
        ? { rename: (_target: unknown, title: string) => { renamed.push(title) } }
        : undefined),
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
      llm: {
        stream: () => (async function* replay() {
          yield { type: 'text-delta', index: 0, text: '面试标题' }
          // Held open so the session can end while the title is still in flight.
          await gate
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      },
    }
    const target = new FakeTargetSession()
    const session = new LiveSession(
      ctx as never,
      config,
      new FakeWorker() as unknown as LiveAsrWorker,
      LiveSessionId('s1'),
      () => {},
    )
    await session.start('五年 Go', target as unknown as Session)
    const disposal = session.dispose()
    release?.()
    await disposal
    // Renaming a session that is no longer live would throw; the title is simply dropped.
    expect(renamed).toEqual([])
    expect(warned).toEqual([])
  })
})

describe('LiveSession conversation context', () => {
  /** One `user/message` event as the session log carries it. */
  function typed(text: string) {
    return { type: 'user/message', data: { content: [{ type: 'text', text }] } }
  }

  it('records the background material that every answer request carries', async () => {
    const { session, target } = await harness([{ deltas: ['ANSWER\n答'] }])
    expect(target.appended[0]).toEqual({ type: 'live-assist/started', data: { background: '我的背景' } })
    await session.dispose()
  })

  it('feeds what the interviewee typed into the answer', async () => {
    const { session, worker, target, requests } = await harness([{ deltas: ['ANSWER\n答'] }])
    target.events = [typed('重点说 Redis，别提 MySQL')]
    speak(worker, 1, '讲讲你的存储选型')
    await session.settled()
    const content = requests[0]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('重点说 Redis，别提 MySQL')
    await session.dispose()
  })

  it('keeps only the newest notes', async () => {
    const { session, worker, target, requests } = await harness([{ deltas: ['ANSWER\n答'] }], { noteTurns: 2 })
    target.events = [typed('第一条'), typed('第二条'), typed('第三条')]
    speak(worker, 1, '一个问题')
    await session.settled()
    const content = requests[0]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('第二条')
    expect(text).toContain('第三条')
    expect(text).not.toContain('第一条')
    await session.dispose()
  })

  it('carries no notes when the interviewee typed nothing', async () => {
    const { session, worker, requests } = await harness([{ deltas: ['ANSWER\n答'] }])
    speak(worker, 1, '一个问题')
    await session.settled()
    const content = requests[0]?.messages[0]?.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('"面试者的补充说明":[]')
    await session.dispose()
  })
})

describe('intervieweeNotes', () => {
  function session(events: { type: string; data: unknown }[]) {
    return { events } as unknown as Session
  }

  it('reads text blocks out of user messages, oldest first', () => {
    expect(intervieweeNotes(session([
      { type: 'user/message', data: { content: [{ type: 'text', text: '甲' }] } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '乙' }] } },
    ]), 8)).toEqual(['甲', '乙'])
  })

  it('joins multiple text blocks in one message', () => {
    expect(intervieweeNotes(session([
      { type: 'user/message', data: { content: [{ type: 'text', text: '前' }, { type: 'text', text: '后' }] } },
    ]), 8)).toEqual(['前后'])
  })

  it.each([
    ['a non-user event', { type: 'live-assist/utterance', data: { text: '对方说的' } }],
    ['a message with no content array', { type: 'user/message', data: { content: 'plain' } }],
    ['a message whose blocks are not text', { type: 'user/message', data: { content: [{ type: 'image' }] } }],
    ['a whitespace-only message', { type: 'user/message', data: { content: [{ type: 'text', text: '  ' }] } }],
    ['a null block', { type: 'user/message', data: { content: [null] } }],
  ])('skips %s', (_label, event) => {
    expect(intervieweeNotes(session([event as never]), 8)).toEqual([])
  })

  it('reads nothing at all when the limit is zero', () => {
    expect(intervieweeNotes(session([
      { type: 'user/message', data: { content: [{ type: 'text', text: '甲' }] } },
    ]), 0)).toEqual([])
  })
})
