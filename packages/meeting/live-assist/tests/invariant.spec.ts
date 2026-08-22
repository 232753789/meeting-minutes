import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('live-assist invariant companion', () => {
  it('reserves package ownership and returns the registry disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const ctx = { invariants: { register } } as unknown as Context

    expect(name).toBe('live-assist-invariant')
    expect(inject).toEqual(['invariants'])
    expect(await apply(ctx)).toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-live-assist', expect.any(Function))

    // The installer is deliberately empty: this package asserts teardown through its
    // lifecycle tests and persists nothing the invariant process could inspect.
    const [, installer] = register.mock.calls[0] as unknown as [string, (ctx: Context) => void]
    installer(ctx)
    expect(register).toHaveBeenCalledTimes(1)
  })
})
