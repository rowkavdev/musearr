import { describe, expect, it, vi } from 'vitest'
import { deliverDiscordDailyBrief, formatDiscordDailyBrief } from './discord.js'

const brief = {
  headline: 'A thoughtful place to begin.',
  summary: 'Today’s Daily Mix starts with Alison by Slowdive.',
  cards: [
    {
      title: 'Start with Alison',
      body: 'Slowdive — You have not played Slowdive in 284 days, despite 42 previous plays.',
    },
  ],
}

describe('Discord daily briefing delivery', () => {
  it('formats a compact, mention-safe daily briefing', () => {
    expect(formatDiscordDailyBrief(brief)).toContain('**Start with Alison**')
  })

  it('posts a persisted briefing without allowing Discord mentions', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    await deliverDiscordDailyBrief('https://discord.com/api/webhooks/123/token', brief, fetcher)

    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://discord.com/api/webhooks/123/token?wait=true' }),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"allowed_mentions":{"parse":[]}'),
      }),
    )
  })

  it('does not leak a webhook URL when Discord rejects delivery', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }))

    await expect(deliverDiscordDailyBrief('https://discord.com/api/webhooks/123/token', brief, fetcher)).rejects.toMatchObject({
      name: 'DiscordDeliveryError',
      message: 'Discord returned HTTP 429.',
    })
  })
})


it('aborts a webhook that never answers and returns a secret-safe error', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('secret webhook URL')), { once: true });
    }));
    const delivery = deliverDiscordDailyBrief('https://discord.com/api/webhooks/123/token', brief, fetcher);
    const checked = expect(delivery).rejects.toMatchObject({ name: 'DiscordDeliveryError', message: 'Discord could not be reached.' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
