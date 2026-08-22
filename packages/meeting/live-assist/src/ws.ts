/** Loopback same-origin WebSocket route carrying PCM uplink and transcript/answer downlink. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { isLoopbackSameOriginRequest } from '@deepseek-ai/dsh-loopback-request'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { ResolvedConfig } from './config.ts'
import { LiveSessionId, type ClientMessage, type ServerMessage } from './protocol.ts'
import { LiveSession } from './session.ts'
import type { LiveAsrWorker } from './worker.ts'

/**
 * Reject an upgrade before protocol negotiation.
 * @param socket - raw HTTP socket, which this function ends.
 * @param status - HTTP status line to send.
 * @param reason - short plain-text body.
 */
export function rejectUpgrade(socket: Duplex, status: string, reason: string): void {
  socket.end([
    `HTTP/1.1 ${status}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(reason))}`,
    '',
    reason,
  ].join('\r\n'))
}

/**
 * Decode one browser control message.
 * @param raw - the socket's text payload.
 * @returns the decoded message, or undefined when it is not one this route accepts.
 */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const value = parsed as Record<string, unknown>
  if (value.type === 'pause') return { type: 'pause' }
  if (value.type === 'resume') return { type: 'resume' }
  if (value.type === 'start' && typeof value.background === 'string' && typeof value.session === 'string') {
    return { type: 'start', background: value.background, session: SessionId(value.session) }
  }
  return undefined
}

/**
 * Normalize one socket payload to a Buffer.
 * @param data - the payload in whichever representation the socket produced.
 * @returns the payload bytes.
 */
export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/**
 * Send one message unless the socket has already left OPEN.
 * @param websocket - the destination socket.
 * @param message - the message to serialize.
 */
export function sendTo(websocket: Pick<WebSocket, 'readyState' | 'send' | 'OPEN'>, message: ServerMessage): void {
  if (websocket.readyState !== websocket.OPEN) return
  websocket.send(JSON.stringify(message))
}

/**
 * Promisify the acceptor's callback-style close.
 * @param server - the no-server acceptor to close.
 * @returns settlement once it has closed, rejecting with whatever it reported.
 */
export function closeAcceptor(server: Pick<WebSocketServer, 'close'>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Owns socket negotiation and one {@link LiveSession} per connection. */
export class LiveAssistSockets {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly sessions = new Map<WebSocket, LiveSession>()
  private closing: Promise<void> | undefined
  private closed = false

  /**
   * @param ctx - plugin context with LLM services.
   * @param config - resolved plugin configuration.
   * @param worker - recognizer shared by every session.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly worker: LiveAsrWorker,
  ) {}

  /**
   * Upgrade one socket and run its session until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handle = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (this.closed) {
      rejectUpgrade(socket, '503 Service Unavailable', 'closing')
      return
    }
    if (!isLoopbackSameOriginRequest(req)) {
      rejectUpgrade(socket, '403 Forbidden', 'loopback same-origin access required')
      return
    }
    if (this.sessions.size >= this.config.maxSessions) {
      rejectUpgrade(socket, '503 Service Unavailable', 'maxSessions reached')
      return
    }
    this.server.handleUpgrade(req, socket, head, (websocket) => { this.accept(websocket) })
  }

  private accept(websocket: WebSocket): void {
    const id = LiveSessionId(randomUUID())
    const send = (message: ServerMessage): void => { sendTo(websocket, message) }
    const session = new LiveSession(this.ctx, this.config, this.worker, id, send)
    this.sessions.set(websocket, session)
    websocket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        session.pushAudio(toBuffer(data))
        return
      }
      const message = parseClientMessage(toBuffer(data).toString('utf8'))
      if (message === undefined) {
        send({ type: 'error', message: 'live-assist: unsupported control message', fatal: false })
        return
      }
      if (message.type === 'pause') {
        session.pause()
        return
      }
      if (message.type === 'resume') {
        session.resume()
        return
      }
      if (Buffer.byteLength(message.background, 'utf8') > this.config.maxBackgroundBytes) {
        send({ type: 'error', message: 'live-assist: background material exceeds maxBackgroundBytes', fatal: true })
        websocket.close(1009, 'background too large')
        return
      }
      const target = this.ctx.sessions.get(message.session)
      if (target === undefined) {
        send({ type: 'error', message: `live-assist: no such session ${message.session}`, fatal: true })
        websocket.close(1011, 'unknown session')
        return
      }
      void session.start(message.background, target).catch((error: unknown) => {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          fatal: true,
        })
        websocket.close(1011, 'recognizer unavailable')
      })
    })
    const release = (): void => {
      if (!this.sessions.delete(websocket)) return
      void session.dispose()
    }
    websocket.once('close', release)
    websocket.once('error', release)
  }

  /**
   * Terminate every socket, dispose its session, and await the acceptor's own close.
   *
   * Idempotent: the acceptor rejects a second `close()`, so repeat callers await the first
   * shutdown instead of starting another.
   * @returns settlement once every socket and session is released.
   */
  dispose(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.closed = true
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const socket of this.server.clients) socket.terminate()
    await Promise.all(sessions.map(session => session.dispose()))
    await closeAcceptor(this.server)
  }
}
