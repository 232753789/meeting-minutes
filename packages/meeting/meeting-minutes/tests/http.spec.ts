import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { MeetingHttpController } from '../src/http.ts'
import type { MeetingMinutesRuntime } from '../src/runtime.ts'
import { meetingDirectory, writeRecord } from '../src/storage.ts'
import { MeetingId, type MeetingRecord } from '../src/types.ts'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

describe('meeting HTTP intake', () => {
  it('accepts a loopback same-origin stream without buffering it into JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-http-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root })
    let accepted: MeetingRecord | undefined
    const enqueue = vi.fn((record: MeetingRecord) => { accepted = record })
    const runtime = {
      config,
      enqueue,
      status: vi.fn(),
    } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${String(port)}`
    const response = await fetch(`${origin}/meeting-minutes/api/meetings`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'audio/webm;codecs=opus',
        'x-meeting-started-at': '2026-08-19T01:15:00.000Z',
        'x-meeting-ended-at': '2026-08-19T01:20:00.000Z',
      },
      body: Buffer.from('recording'),
    })
    expect(response.status).toBe(202)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(accepted?.originalFilename).toBe('original.webm')
    await expect(readFile(join(meetingDirectory(config, accepted!.id), 'original.webm'), 'utf8')).resolves.toBe('recording')
    await controller.dispose()
  })

  it('refuses a cross-site browser request before reading the body', async () => {
    const config = resolveConfig({ asrMode: 'remote', storageRoot: './unused' })
    const runtime = { config } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${String(port)}/meeting-minutes/api/meetings`, {
      method: 'POST',
      headers: {
        origin: `https://127.0.0.1:${String(port)}`,
        'content-type': 'audio/webm',
        'x-meeting-started-at': '2026-08-19T01:15:00.000Z',
        'x-meeting-ended-at': '2026-08-19T01:20:00.000Z',
      },
      body: Buffer.from('not-read'),
    })
    expect(response.status).toBe(403)
    await controller.dispose()
  })

  it('downloads the preserved original recording with its media type and filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-http-original-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root })
    const id = MeetingId('meeting-20260819T091500-012345abcdef')
    const directory = meetingDirectory(config, id)
    await mkdir(directory)
    await writeFile(join(directory, 'original.webm'), 'recording')
    await writeRecord(config, {
      formatVersion: 1,
      id,
      stage: 'failed',
      createdAt: '2026-08-19T01:15:00.000Z',
      startedAt: '2026-08-19T01:15:00.000Z',
      endedAt: '2026-08-19T01:20:00.000Z',
      updatedAt: '2026-08-19T01:21:00.000Z',
      originalFilename: 'original.webm',
      originalMimeType: 'audio/webm;codecs=opus',
      originalBytes: 9,
      completedChunks: 0,
      error: 'ASR failed',
    })
    const runtime = { config } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${String(port)}`

    const response = await fetch(`${origin}/meeting-minutes/api/meetings/${id}/original`, {
      headers: { origin, range: 'bytes=1-3' },
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('audio/webm;codecs=opus')
    const disposition = response.headers.get('content-disposition')
    expect(disposition).toContain('attachment; filename="original.webm"')
    expect(disposition).toContain('filename*=UTF-8')
    await expect(response.text()).resolves.toBe('eco')
    await controller.dispose()
  })

  it('lists stored meetings and refuses other collection methods', async () => {
    const config = resolveConfig({ asrMode: 'remote', storageRoot: './unused' })
    const list = vi.fn().mockResolvedValue([
      { id: 'meeting-20260820T010000-00000000000c', stage: 'complete', name: '周会.md', createdAt: '2026-08-20T01:00:00.000Z' },
      { id: 'meeting-20260819T091500-00000000000a', stage: 'failed', name: '晨会录音.mp4', createdAt: '2026-08-19T01:15:00.000Z' },
    ])
    const runtime = { config, list } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${String(port)}`

    const response = await fetch(`${origin}/meeting-minutes/api/meetings`, { headers: { origin } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      meetings: [
        { id: 'meeting-20260820T010000-00000000000c', stage: 'complete', name: '周会.md', createdAt: '2026-08-20T01:00:00.000Z' },
        { id: 'meeting-20260819T091500-00000000000a', stage: 'failed', name: '晨会录音.mp4', createdAt: '2026-08-19T01:15:00.000Z' },
      ],
    })
    expect((await fetch(`${origin}/meeting-minutes/api/meetings`, { method: 'DELETE', headers: { origin } })).status)
      .toBe(405)
    await controller.dispose()
  })

  it('downloads the transcript under its minutes name and refuses it before ASR publishes one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-http-transcript-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root })
    const published = MeetingId('meeting-20260819T091500-012345abcdef')
    const pending = MeetingId('meeting-20260819T091500-abcdef012345')
    const base = {
      formatVersion: 1,
      stage: 'complete',
      createdAt: '2026-08-19T01:15:00.000Z',
      startedAt: '2026-08-19T01:15:00.000Z',
      endedAt: '2026-08-19T01:20:00.000Z',
      updatedAt: '2026-08-19T01:21:00.000Z',
      originalFilename: 'original.mp4',
      originalMimeType: 'audio/mp4',
      originalBytes: 9,
      completedChunks: 1,
    } as const
    await mkdir(meetingDirectory(config, published))
    await writeFile(join(meetingDirectory(config, published), 'transcript.txt'), '完整转写。\n')
    await writeRecord(config, {
      ...base,
      id: published,
      transcriptText: 'transcript.txt',
      minutesFilename: '2026-08-19_09-15_周会_5m.md',
    })
    await mkdir(meetingDirectory(config, pending))
    await writeRecord(config, { ...base, id: pending, stage: 'transcribing' })
    const runtime = { config } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${String(port)}`

    const response = await fetch(`${origin}/meeting-minutes/api/meetings/${published}/transcript`, {
      headers: { origin },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('2026-08-19_09-15_周会_5m.txt')}`,
    )
    await expect(response.text()).resolves.toBe('完整转写。\n')
    expect((await fetch(`${origin}/meeting-minutes/api/meetings/${pending}/transcript`, { headers: { origin } })).status)
      .toBe(409)
    await controller.dispose()
  })

  it('persists a sanitized upload filename and rejects a malformed one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-http-upload-'))
    const config = resolveConfig({ asrMode: 'remote', storageRoot: root })
    let accepted: MeetingRecord | undefined
    const runtime = {
      config,
      enqueue: vi.fn((record: MeetingRecord) => { accepted = record }),
    } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${String(port)}`
    const headers = {
      origin,
      'content-type': 'video/mp4',
      'x-meeting-started-at': '2026-08-19T01:15:00.000Z',
      'x-meeting-ended-at': '2026-08-19T01:20:00.000Z',
    }

    const response = await fetch(`${origin}/meeting-minutes/api/meetings`, {
      method: 'POST',
      headers: { ...headers, 'x-meeting-source-filename': encodeURIComponent('~/会议/晨会 录音.mp4') },
      body: Buffer.from('uploaded'),
    })
    expect(response.status).toBe(202)
    expect(accepted?.sourceFilename).toBe('晨会 录音.mp4')
    expect(accepted?.originalFilename).toBe('original.mp4')

    const malformed = await fetch(`${origin}/meeting-minutes/api/meetings`, {
      method: 'POST',
      headers: { ...headers, 'x-meeting-source-filename': '%zz' },
      body: Buffer.from('uploaded'),
    })
    expect(malformed.status).toBe(400)
    await controller.dispose()
  })

  it('maps deletion to removed, missing, and active responses', async () => {
    const config = resolveConfig({ asrMode: 'remote', storageRoot: './unused' })
    const remove = vi.fn()
      .mockResolvedValueOnce({ kind: 'deleted' })
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({ kind: 'conflict' })
    const runtime = { config, remove } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${String(port)}`
    const path = `${origin}/meeting-minutes/api/meetings/meeting-20260819T091500-012345abcdef`

    const deleted = await fetch(path, { method: 'DELETE', headers: { origin } })
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toEqual({ id: 'meeting-20260819T091500-012345abcdef' })
    expect((await fetch(path, { method: 'DELETE', headers: { origin } })).status).toBe(404)
    expect((await fetch(path, { method: 'DELETE', headers: { origin } })).status).toBe(409)
    expect((await fetch(path, { method: 'PUT', headers: { origin } })).status).toBe(405)
    expect(remove).toHaveBeenCalledTimes(3)
    await controller.dispose()
  })

  it('maps retry admission to accepted, missing, and conflict responses', async () => {
    const config = resolveConfig({ asrMode: 'remote', storageRoot: './unused' })
    const retry = vi.fn()
      .mockResolvedValueOnce({ kind: 'accepted' })
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({ kind: 'conflict' })
    const runtime = { config, retry } as unknown as MeetingMinutesRuntime
    const controller = new MeetingHttpController(runtime)
    const server = createServer((req, res) => { void controller.handle(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${String(port)}`
    const path = `${origin}/meeting-minutes/api/meetings/meeting-20260819T091500-012345abcdef/retry`

    const accepted = await fetch(path, { method: 'POST', headers: { origin } })
    expect(accepted.status).toBe(202)
    await expect(accepted.json()).resolves.toMatchObject({
      id: 'meeting-20260819T091500-012345abcdef',
      statusUrl: '/meeting-minutes/api/meetings/meeting-20260819T091500-012345abcdef',
    })
    expect((await fetch(path, { method: 'POST', headers: { origin } })).status).toBe(404)
    expect((await fetch(path, { method: 'POST', headers: { origin } })).status).toBe(409)
    expect((await fetch(path, { method: 'GET', headers: { origin } })).status).toBe(405)
    expect(retry).toHaveBeenCalledTimes(3)
    await controller.dispose()
  })
})
