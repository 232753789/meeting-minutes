import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { meetingDirectory, readSummaryRequests } from '../src/storage.ts'
import { summarizeMeeting } from '../src/summary.ts'
import { MeetingId } from '../src/types.ts'

class NonReducingAdapter extends LlmAdapter {
  calls = 0

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'text-delta', index: 0, text: '摘要'.repeat(2_500) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('hierarchical meeting summary', () => {
  it('fails when a reduction round does not make the combined input smaller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-summary-'))
    const id = MeetingId('meeting-20260819T091500-012345abcdef')
    await mkdir(meetingDirectory(resolveConfig({ asrMode: 'remote', storageRoot: root }), id))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new NonReducingAdapter()
    ctx.llm.registerAdapter(['summary-fixture'], adapter)
    const config = resolveConfig({
      asrMode: 'remote',
      storageRoot: root,
      summaryProvider: 'summary-fixture',
      summaryModel: 'summary-model',
      summaryMaxInputBytes: 8_192,
      summaryMaxReductionRounds: 2,
    })

    await expect(summarizeMeeting(
      ctx,
      config,
      id,
      '转写'.repeat(4_000),
      new AbortController().signal,
      [],
    )).rejects.toThrow('hierarchical summary did not reduce its input')
    expect(adapter.calls).toBeGreaterThan(2)
    await ctx.fiber.dispose()
  })
})

/** Answers every request, optionally failing at one position and producing invalid final JSON. */
class ScriptedAdapter extends LlmAdapter {
  readonly systems: string[] = []
  failAt: number | undefined
  finalOutput = JSON.stringify({ topic: '季度复盘', summaryMarkdown: '### 决策\n\n继续推进。' })

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.system ?? ''
    this.systems.push(system)
    if (this.systems.length === this.failAt) throw new Error('summary route unavailable')
    const text = system.includes('只返回一个 JSON 对象')
      ? this.finalOutput
      : `第 ${String(this.systems.length)} 段摘要。`
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function scripted(prefix: string, extra: Partial<Parameters<typeof resolveConfig>[0]> = {}): Promise<{
  ctx: Context
  config: ResolvedConfig
  id: MeetingId
  adapter: ScriptedAdapter
}> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const id = MeetingId('meeting-20260819T091500-012345abcdef')
  const config = resolveConfig({
    asrMode: 'remote',
    storageRoot: root,
    summaryProvider: 'summary-fixture',
    summaryModel: 'summary-model',
    ...extra,
  })
  await mkdir(meetingDirectory(config, id), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['summary-fixture'], adapter)
  return { ctx, config, id, adapter }
}

describe('summary reuse across attempts', () => {
  it('redispatches only the requests the failed attempt never completed', async () => {
    const { ctx, config, id, adapter } = await scripted('meeting-summary-resume-', {
      summaryMaxInputBytes: 8_192,
    })
    const transcript = '转写'.repeat(4_000)
    adapter.failAt = 3
    const signal = new AbortController().signal

    await expect(summarizeMeeting(ctx, config, id, transcript, signal, []))
      .rejects.toThrow('summary route unavailable')
    // The audit holds three requests; the one the failure stopped carries no output, so the
    // completed run ends before it.
    const interrupted = await readSummaryRequests(config, id)
    expect(interrupted).toHaveLength(2)
    const dispatchedBefore = adapter.systems.length

    adapter.failAt = undefined
    await expect(summarizeMeeting(ctx, config, id, transcript, signal, interrupted))
      .resolves.toEqual({ topic: '季度复盘', summaryMarkdown: '### 决策\n\n继续推进。' })

    const completed = await readSummaryRequests(config, id)
    expect(completed.every(request => request.output !== undefined)).toBe(true)
    expect(completed.map(request => request.index)).toEqual(completed.map((_value, index) => index))
    // The two requests the first attempt completed carry its instants, so they were replayed rather
    // than sent again; every later position cost one dispatch.
    expect(completed.slice(0, 2)).toEqual(interrupted)
    expect(adapter.systems.length - dispatchedBefore).toBe(completed.length - 2)

    // A retranscribed meeting carries different inputs at every position, so nothing is reused.
    const beforeChangedTranscript = adapter.systems.length
    await expect(summarizeMeeting(ctx, config, id, '纪要'.repeat(4_000), signal, completed))
      .resolves.toMatchObject({ topic: '季度复盘' })
    expect(adapter.systems.length - beforeChangedTranscript).toBe(completed.length)
    await ctx.fiber.dispose()
  })

  it('sends the final request again because its persisted output is what failed to parse', async () => {
    const { ctx, config, id, adapter } = await scripted('meeting-summary-final-')
    adapter.finalOutput = '这不是 JSON。'
    const signal = new AbortController().signal

    await expect(summarizeMeeting(ctx, config, id, '一段短转写。', signal, []))
      .rejects.toThrow('final summary is not valid JSON')
    const rejected = await readSummaryRequests(config, id)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.output).toBe('这不是 JSON。')

    adapter.finalOutput = JSON.stringify({ topic: '季度复盘', summaryMarkdown: '### 决策\n\n继续推进。' })
    await expect(summarizeMeeting(ctx, config, id, '一段短转写。', signal, rejected))
      .resolves.toMatchObject({ topic: '季度复盘' })
    expect(adapter.systems).toHaveLength(2)
    await expect(readFile(join(meetingDirectory(config, id), 'summary-requests.json'), 'utf8'))
      .resolves.toContain('季度复盘')
    await ctx.fiber.dispose()
  })
})
