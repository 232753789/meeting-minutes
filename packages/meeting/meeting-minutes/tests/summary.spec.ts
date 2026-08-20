import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { meetingDirectory } from '../src/storage.ts'
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
    )).rejects.toThrow('hierarchical summary did not reduce its input')
    expect(adapter.calls).toBeGreaterThan(2)
    await ctx.fiber.dispose()
  })
})
