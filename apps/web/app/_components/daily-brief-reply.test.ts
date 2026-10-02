import { describe, expect, it } from 'vitest'
import { readDailyBrief } from './daily-brief-reply'

const ok = (body: () => Promise<unknown>) => ({ ok: true, json: body })

describe('readDailyBrief', () => {
  it('returns the brief', async () => {
    expect(await readDailyBrief(ok(async () => ({ brief: { id: 'b1' } })))).toEqual({ id: 'b1' })
  })
  it('treats bad JSON as no brief', async () => {
    expect(await readDailyBrief(ok(async () => { throw new SyntaxError('bad') }))).toBeNull()
  })
  it.each([[null], [{}], [{ brief: null }]])('treats %j as no brief', async (body) => {
    expect(await readDailyBrief(ok(async () => body))).toBeNull()
  })
  it('treats a failed request or non-ok reply as no brief', async () => {
    expect(await readDailyBrief(null)).toBeNull()
    expect(await readDailyBrief({ ok: false, json: async () => ({ brief: { id: 'x' } }) })).toBeNull()
    expect(await readDailyBrief(Promise.reject(new Error('net')))).toBeNull()
  })
})
