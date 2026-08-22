/**
 * The loopback same-origin fence shared by Host plugins whose routes a browser on this
 * machine reaches directly.
 *
 * It defends the two confused-deputy paths such a route opens: DNS rebinding, where `Host`
 * names an attacker's domain while the socket lands here, and cross-site requests fired from
 * a malicious page. A WebSocket upgrade is not covered by CORS at all, so for upgrade routes
 * this fence is the only thing between a hostile page and the route.
 *
 * Deployments that serve a LAN authority need the broader `trustedHosts` policy owned by
 * `dsh-client-connection`; this module is deliberately loopback-only.
 * @module @deepseek-ai/dsh-loopback-request
 */

import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'

/** The request facts the fence reads. */
export interface FencedRequest {
  readonly headers: IncomingHttpHeaders
}

function header(request: FencedRequest, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function authorityUrl(authority: string): URL | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost and its subdomains, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '[::1]' || normalized === '::1') {
    return true
  }
  if (isIP(normalized) !== 4) return false
  return Number(normalized.split('.', 1)[0]) === 127
}

/**
 * Decide whether one browser-facing request may reach a loopback-only route.
 *
 * `Host` must name a loopback authority, an explicit cross-site fetch marker is refused, and
 * an `Origin` the browser attached must be exactly this authority. An absent `Origin` passes:
 * the `Host` check already bound the request, and a plain HTTP browser read carries none.
 * @param request - the incoming request, before any body bytes are consumed.
 * @returns whether the request satisfies the local-only policy.
 */
export function isLoopbackSameOriginRequest(request: FencedRequest): boolean {
  const host = header(request, 'host')
  if (host === undefined) return false
  const hostUrl = authorityUrl(host)
  if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) return false
  if (header(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).origin === hostUrl.origin
  } catch {
    return false
  }
}
