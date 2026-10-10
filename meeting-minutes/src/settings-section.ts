/**
 * The optional-settings consumer wiring, carried from `@deepseek-ai/dsh-settings` so the
 * standalone package keeps its behaviour on every Host that serves the `settings` service.
 *
 * Only the service's `register` / `get` / `watch` surface is used, which every settings
 * provider exposes; the helper functions themselves are not part of the published API on all
 * Harness releases, so the package owns its copy instead of importing them.
 */

import type { Context } from '@deepseek-ai/cordis'

/** A validated settings namespace identifier. */
export type SettingsNamespace = string & { readonly __settingsNamespace: true }

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Cordis `FiberState` values during which no fallback work may start, mirrored as literals: a
 * const enum has no runtime object to import.
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/**
 * Validate a settings namespace: a lowercase letter followed by lowercase letters, digits, or `-`.
 * @param value - candidate namespace.
 * @returns the namespace, branded.
 * @throws {TypeError} when `value` is not a lowercase hyphenated identifier.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}

/**
 * Deep equality over JSON-compatible data (objects, arrays, primitives) — the settings
 * service's change-detection predicate.
 * @param a - one JSON-compatible value.
 * @param b - the other JSON-compatible value.
 * @returns whether the two values are structurally equal.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqualJson(left[key], right[key]))
}

/** Hooks a consumer hands to {@link installSettingsSection}. */
export interface SettingsSectionHooks<T> {
  /**
   * Receive the active configuration source: the resolved settings scope while one is
   * attached, the composition entry otherwise. Called before the matching `onChange`.
   * @param current - thunk returning the currently authoritative value.
   */
  setSource(current: () => T): void
  /** Re-judge anything derived from the source after an attach, a detach, or a committed change. */
  onChange(): void
  /**
   * Reject a resolved section this consumer could not act on, for constraints its schema
   * cannot express.
   * @param value - the resolved section, schema-valid by construction.
   */
  validate?: (value: T) => void
}

function isUnloading(ctx: Context): boolean {
  const state: unknown = ctx.fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * While a settings service exists, register `ns` with the consumer's composition entry as the
 * `base` layer and point the source thunk at the resolved scope; when the service goes away
 * (disposal, provider reload), fall back to the entry so the consumer keeps running on its
 * composition config.
 * @param ctx - the consumer's plugin context.
 * @param ns - consumer-owned settings namespace.
 * @param schema - schemastery schema resolving the namespace.
 * @param entry - composition entry used as the base and fallback value.
 * @param hooks - source sink, change notification, and optional validation.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: unknown,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx: Context) => {
    const scope = sctx.settings.register(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    })
    hooks.setSource(() => scope.get() as T)
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}
