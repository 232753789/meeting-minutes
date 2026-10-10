/** The `meeting-minutes` settings section and the installation it replaces. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/config.ts'
import { MeetingMinutesInstallation } from '../src/lifecycle.ts'
import { meetingDirectory, writeRecord } from '../src/storage.ts'
import { MeetingId, type MeetingRecord } from '../src/types.ts'
import * as MeetingMinutes from '../src/index.ts'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

class SubprocessFixture extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function boot(storageRoot: string): Promise<{ port: number }> {
  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(SubprocessFixture)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentDefaultModel, { provider: 'fixture', model: 'fixture' })
  const settings = ctx.plugin(MemorySettings)
  await settings.await()
  const plugin = ctx.plugin(MeetingMinutes, {
    asrMode: 'remote',
    storageRoot,
    timeZone: 'Asia/Shanghai',
  })
  await plugin.await()
  return { port: ctx.webServer.port }
}

function storedMeeting(id: string, createdAt: string): MeetingRecord {
  return {
    formatVersion: 1,
    id: MeetingId(id),
    stage: 'complete',
    createdAt,
    startedAt: createdAt,
    endedAt: createdAt,
    updatedAt: createdAt,
    originalFilename: 'original.mp4',
    originalMimeType: 'audio/mp4',
    originalBytes: 4,
    completedChunks: 1,
    minutesFilename: '2026-08-19_09-15_周会_5m.md',
  }
}

describe('meeting-minutes settings section', () => {
  it('serves the storage root a saved setting selects', async () => {
    const composed = await mkdtemp(join(tmpdir(), 'meeting-settings-composed-'))
    const chosen = await mkdtemp(join(tmpdir(), 'meeting-settings-chosen-'))
    const record = storedMeeting('meeting-20260819T091500-0000000000d1', '2026-08-19T01:21:00.000Z')
    const { port } = await boot(composed)
    const origin = `http://127.0.0.1:${String(port)}`
    const config = resolveConfig({ asrMode: 'remote', storageRoot: chosen })
    await mkdir(meetingDirectory(config, record.id), { recursive: true })
    await writeRecord(config, record)

    const before = await fetch(`${origin}/meeting-minutes/api/meetings`, { headers: { origin } })
    await expect(before.json()).resolves.toEqual({ meetings: [] })

    await ctx!.settings.update(MeetingMinutes.MEETING_MINUTES_NAMESPACE, { storageRoot: chosen })

    const after = await fetch(`${origin}/meeting-minutes/api/meetings`, { headers: { origin } })
    await expect(after.json()).resolves.toEqual({
      meetings: [{
        id: record.id,
        stage: 'complete',
        name: '2026-08-19_09-15_周会_5m.md',
        createdAt: '2026-08-19T01:21:00.000Z',
      }],
    })
  })

  it('refuses a section the plugin could not run and keeps serving the last one', async () => {
    const composed = await mkdtemp(join(tmpdir(), 'meeting-settings-invalid-'))
    const { port } = await boot(composed)
    const origin = `http://127.0.0.1:${String(port)}`

    await expect(ctx!.settings.update(MeetingMinutes.MEETING_MINUTES_NAMESPACE, {
      asrMode: 'local',
      localModelPath: join(composed, 'absent-model'),
    })).rejects.toThrow(/localModelPath is not a directory/)

    const response = await fetch(`${origin}/meeting-minutes/api/meetings`, { headers: { origin } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ meetings: [] })
  })
})

describe('meeting-minutes installation', () => {
  it('installs once per distinct configuration and releases the previous one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-install-'))
    await writeFile(join(root, 'placeholder'), '')
    const disposals: string[] = []
    const registrations: string[] = []
    const fake = {
      logger: { warn: vi.fn() },
      webServer: {
        register: () => {
          registrations.push('route')
          return () => { disposals.push('route') }
        },
      },
      effect: (execute: () => () => Promise<void>) => {
        const disposer = execute()
        return async () => { await disposer() }
      },
    } as unknown as Context
    const installation = new MeetingMinutesInstallation(fake)
    const first = resolveConfig({ asrMode: 'remote', storageRoot: root })

    installation.apply(first)
    await installation.settled()
    expect(registrations).toHaveLength(1)

    installation.apply(resolveConfig({ asrMode: 'remote', storageRoot: root }))
    await installation.settled()
    expect(registrations).toHaveLength(1)

    installation.apply(resolveConfig({ asrMode: 'remote', storageRoot: join(root, 'next') }))
    await installation.settled()
    expect(registrations).toHaveLength(2)
    expect(disposals).toEqual(['route'])

    await installation.dispose()
    expect(disposals).toEqual(['route', 'route'])
  })
})
