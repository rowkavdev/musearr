import { describe, expect, it } from 'vitest'
import { readOverviewRefresh, shouldPollSync } from './sync-poll'

describe('shouldPollSync', () => {
  it.each([['queued', true], ['running', true], ['completed', false], ['failed', false], ['cancelled', false], ['not_started', false], [undefined, false]] as const)(
    '%s -> %s',
    (status, expected) => expect(shouldPollSync(status)).toBe(expected),
  )
})

describe('readOverviewRefresh', () => {
  const ok = (body: () => Promise<unknown>) => ({ ok: true, json: body })
  it('returns a usable overview', async () => {
    const overview = { sync: { status: 'completed' } }
    expect(await readOverviewRefresh(ok(async () => overview))).toBe(overview)
  })
  it('keeps what is on screen for a non-ok reply, bad JSON, null or a body without sync', async () => {
    expect(await readOverviewRefresh({ ok: false, json: async () => ({ sync: {} }) })).toBeNull()
    expect(await readOverviewRefresh(ok(async () => { throw new SyntaxError('x') }))).toBeNull()
    expect(await readOverviewRefresh(ok(async () => null))).toBeNull()
    expect(await readOverviewRefresh(ok(async () => ({})))).toBeNull()
  })
})
