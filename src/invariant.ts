/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-meeting-minutes`.
 * @module @deepseek-ai/dsh-meeting-minutes/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-meeting-minutes'

/** Cordis companion plugin name. */
export const name = 'meeting-minutes-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns private files,
 * HTTP handlers, and subprocesses whose teardown is asserted by its lifecycle
 * tests. Browser state lives outside the Host invariant process.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
