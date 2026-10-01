export type DiscordBriefContent = {
  headline: string
  summary: string
  cards: Array<{ title: string; body: string }>
}

type Fetcher = (input: URL, init: RequestInit) => Promise<Response>

export class DiscordDeliveryError extends Error {
  constructor(status?: number) {
    super(status ? `Discord returned HTTP ${status}.` : 'Discord could not be reached.')
    this.name = 'DiscordDeliveryError'
  }
}

export function formatDiscordDailyBrief(brief: DiscordBriefContent): string {
  const cards = brief.cards.slice(0, 4).map((card) => `**${card.title}**\n${card.body}`)
  return ['🎧 **Musearr daily brief**', `**${brief.headline}**`, brief.summary, ...cards].join('\n\n').slice(0, 1_900)
}

export async function deliverDiscordDailyBrief(
  webhookUrl: string,
  brief: DiscordBriefContent,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const url = new URL(webhookUrl)
  url.searchParams.set('wait', 'true')
  let response: Response
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    response = await fetcher(url, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: formatDiscordDailyBrief(brief),
        allowed_mentions: { parse: [] },
      }),
    })
  } catch {
    throw new DiscordDeliveryError()
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new DiscordDeliveryError(response.status)
  }
}
