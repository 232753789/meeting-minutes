import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('loopback-request invariant companion', () => {
  it('reserves package ownership and returns the registry disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const ctx = { invariants: { register } } as unknown as Context

    expect(name).toBe('loopback-request-invariant')
    expect(inject).toEqual(['invariants'])
    expect(await apply(ctx)).toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-loopback-request', expect.any(Function))

    // The installer is deliberately empty: this package owns two pure predicates.
    const [, installer] = register.mock.calls[0] as unknown as [string, (ctx: Context) => void]
    installer(ctx)
    expect(register).toHaveBeenCalledTimes(1)
  })
})
