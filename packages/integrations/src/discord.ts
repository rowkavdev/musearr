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
  const text = ['🎧 **Musearr daily brief**', `**${brief.headline}**`, brief.summary, ...cards].join('\n\n')
  let end = 1_900
  // Keep a UTF-16 surrogate pair together at the content limit.
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1
  return text.slice(0, end)
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

  // wait=true returns a message body, but delivery only needs the status.
  // Release it without buffering it or letting cleanup failure cause a retry
  // of a post that Discord has already accepted.
  void response.body?.cancel().catch(() => {})

  if (!response.ok) {
    throw new DiscordDeliveryError(response.status)
  }
}
