import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as MeetingMinutes from '../src/index.ts'

class SubprocessFixture extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }
}

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('meeting-minutes real Loader composition', () => {
  it('boots the Host plugin from cordis.yml and serves its loopback route', async () => {
    root = await mkdtemp(join(tmpdir(), 'meeting-minutes-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      "- name: '@test/subprocess'",
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: fixture',
      '    model: fixture',
      "- name: '@deepseek-ai/dsh-meeting-minutes'",
      '  config:',
      '    asrMode: remote',
      `    storageRoot: ${JSON.stringify(join(root, 'meetings'))}`,
      '    timeZone: Asia/Shanghai',
      '',
    ].join('\n'))

    ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@test/subprocess', SubprocessFixture],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
      ['@deepseek-ai/dsh-meeting-minutes', MeetingMinutes],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const port = ctx.webServer.port
    const response = await fetch(`http://127.0.0.1:${String(port)}/meeting-minutes/api/meetings/not-an-id`)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'meeting not found' })

    await ctx.fiber.dispose()
    ctx = undefined
    await expect(fetch(`http://127.0.0.1:${String(port)}/meeting-minutes/api/meetings/not-an-id`))
      .rejects.toThrow()
  })
})
