/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-loopback-request`.
 * @module @deepseek-ai/dsh-loopback-request/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-loopback-request'

/** Cordis companion plugin name. */
export const name = 'loopback-request-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns two pure predicates
 * with no registrations, no state, and no owned relationships to assert.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
