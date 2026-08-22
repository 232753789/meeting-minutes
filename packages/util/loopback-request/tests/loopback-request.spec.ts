import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isLoopbackHostname, isLoopbackSameOriginRequest } from '../src/index.ts'

function request(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isLoopbackHostname', () => {
  it.each([
    'localhost',
    'app.localhost',
    '[::1]',
    '::1',
    '127.0.0.1',
    '127.255.255.254',
    'LOCALHOST',
  ])('accepts %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true)
  })

  it.each([
    'example.com',
    '10.0.0.5',
    '192.168.1.4',
    '128.0.0.1',
    'localhost.evil.com',
    '127.0.0.1.evil.com',
    '',
  ])('refuses %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false)
  })
})

describe('isLoopbackSameOriginRequest', () => {
  it.each([
    ['a bare loopback authority', { host: '127.0.0.1:8080' }],
    ['localhost with a port', { host: 'localhost:3000' }],
    ['a .localhost subdomain', { host: 'app.localhost:3000' }],
    ['IPv6 loopback', { host: '[::1]:3000' }],
    ['a matching Origin', { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }],
    ['a same-origin fetch marker', { host: 'localhost:1', 'sec-fetch-site': 'same-origin' }],
    ['a same-site fetch marker', { host: 'localhost:1', 'sec-fetch-site': 'same-site' }],
  ])('accepts %s', (_label, headers) => {
    expect(isLoopbackSameOriginRequest(request(headers))).toBe(true)
  })

  it.each([
    ['a missing Host', {}],
    ['an empty Host', { host: '' }],
    ['a public Host', { host: 'example.com' }],
    ['a non-loopback IPv4', { host: '10.0.0.5:8080' }],
    ['a cross-site marker', { host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' }],
    ['a foreign Origin', { host: '127.0.0.1:8080', origin: 'https://evil.example' }],
    ['a same-host Origin on another scheme', { host: '127.0.0.1:8080', origin: 'https://127.0.0.1:8080' }],
    ['an opaque Origin', { host: '127.0.0.1:8080', origin: 'null' }],
    ['an unparsable Origin', { host: '127.0.0.1:8080', origin: '://' }],
  ])('refuses %s', (_label, headers) => {
    expect(isLoopbackSameOriginRequest(request(headers))).toBe(false)
  })

  it('refuses a repeated Host header, which node exposes as an array', () => {
    expect(isLoopbackSameOriginRequest(request({ host: ['127.0.0.1:1', 'evil.example'] }))).toBe(false)
  })

  it('ignores a repeated Origin header rather than trusting one of its values', () => {
    expect(isLoopbackSameOriginRequest(request({
      host: '127.0.0.1:8080',
      origin: ['http://127.0.0.1:8080', 'https://evil.example'],
    }))).toBe(true)
  })
})
