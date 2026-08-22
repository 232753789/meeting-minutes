/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-live-assist`.
 * @module @deepseek-ai/dsh-live-assist/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-live-assist'

/** Cordis companion plugin name. */
export const name = 'live-assist-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns upgraded sockets and a
 * subprocess whose teardown is asserted by its lifecycle tests, and it
 * persists nothing. Browser state lives outside the Host invariant process.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
