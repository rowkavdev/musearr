import { describe, expect, it, vi } from 'vitest'
import { deliverDiscordDailyBrief } from './discord.js'

const brief = { headline: 'Today', summary: 'A mix', cards: [] }
const webhook = 'https://discord.com/api/webhooks/123/token'

describe('unused Discord reply bodies', () => {
  it.each([200, 429])('cancels the unused body for HTTP %i', async (status) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { status })
    const delivery = deliverDiscordDailyBrief(webhook, brief, vi.fn().mockResolvedValue(response))
    if (status === 200) await expect(delivery).resolves.toBeUndefined()
    else await expect(delivery).rejects.toMatchObject({ message: 'Discord returned HTTP 429.' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not turn cleanup rejection into a failed successful delivery', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('secret webhook URL'))
    const response = new Response(new ReadableStream({ cancel }), { status: 200 })
    await expect(deliverDiscordDailyBrief(webhook, brief, vi.fn().mockResolvedValue(response))).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(1)
    await Promise.resolve()
  })

  it('does not wait for a stalled cleanup promise', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream({ cancel }), { status: 200 })
    await expect(deliverDiscordDailyBrief(webhook, brief, vi.fn().mockResolvedValue(response))).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('allows bodyless replies', async () => {
    await expect(deliverDiscordDailyBrief(webhook, brief, vi.fn().mockResolvedValue(new Response(null, { status: 204 })))).resolves.toBeUndefined()
  })
})
