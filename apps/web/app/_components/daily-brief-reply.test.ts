import { describe, expect, it } from 'vitest'
import { readDailyBrief } from './daily-brief-reply'

const good = { id: 'b1', createdAt: '2026-10-02T00:00:00Z', content: { headline: 'h', summary: 's', cards: [{ kind: 'sync', title: 't', body: 'b' }] }, discordDelivery: null }

const ok = (body: () => Promise<unknown>) => ({ ok: true, json: body })

describe('readDailyBrief', () => {
  it('returns the brief', async () => {
    expect(await readDailyBrief(ok(async () => ({ brief: good })))).toEqual(good)
  })
  it('treats bad JSON as no brief', async () => {
    expect(await readDailyBrief(ok(async () => { throw new SyntaxError('bad') }))).toBeNull()
  })
  it.each([[null], [{}], [{ brief: null }]])('treats %j as no brief', async (body) => {
    expect(await readDailyBrief(ok(async () => body))).toBeNull()
  })
  it.each([
    ['no content', { ...good, content: undefined }],
    ['cards not an array', { ...good, content: { ...good.content, cards: 'x' } }],
    ['a null card', { ...good, content: { ...good.content, cards: [null] } }],
    ['a card without a body', { ...good, content: { ...good.content, cards: [{ kind: 'sync', title: 't' }] } }],
    ['no headline', { ...good, content: { ...good.content, headline: 4 } }],
    ['no createdAt', { ...good, createdAt: undefined }],
    ['a bad delivery', { ...good, discordDelivery: 'x' }],
    ['an array', [good]],
  ])('treats a brief with %s as no brief', async (_name, brief) => {
    expect(await readDailyBrief(ok(async () => ({ brief })))).toBeNull()
  })
  it('treats a failed request or non-ok reply as no brief', async () => {
    expect(await readDailyBrief(null)).toBeNull()
    expect(await readDailyBrief({ ok: false, json: async () => ({ brief: { id: 'x' } }) })).toBeNull()
    expect(await readDailyBrief(Promise.reject(new Error('net')))).toBeNull()
  })
})
