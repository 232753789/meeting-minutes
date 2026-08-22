/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ndjson-worker`.
 * @module @deepseek-ai/dsh-ndjson-worker/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ndjson-worker'

/** Cordis companion plugin name. */
export const name = 'ndjson-worker-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers nothing and owns no
 * global state. Each worker instance belongs to the plugin that constructed it,
 * whose own lifecycle tests assert that its process is released.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
