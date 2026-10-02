type BriefReply = { ok: boolean; json: () => Promise<unknown> } | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The home page reads these fields straight into the markup, so a brief that
// is missing one (or has the wrong type) would throw while rendering.
function isRenderableBrief(value: unknown): boolean {
  if (!isRecord(value) || typeof value.createdAt !== 'string') return false
  const content = value.content
  if (!isRecord(content) || typeof content.headline !== 'string' || typeof content.summary !== 'string') return false
  if (!Array.isArray(content.cards)) return false
  if (!content.cards.every((card) => isRecord(card) && typeof card.kind === 'string' && typeof card.title === 'string' && typeof card.body === 'string')) return false
  const delivery = value.discordDelivery
  return delivery === undefined || delivery === null || (isRecord(delivery) && typeof delivery.status === 'string')
}

// The daily brief is optional on the home page, so any bad reply reads as "no brief".
export async function readDailyBrief<T>(reply: BriefReply | Promise<BriefReply>): Promise<T | null> {
  try {
    const response = await reply
    if (!response?.ok) return null
    const payload = (await response.json()) as { brief?: unknown } | null
    const brief = payload?.brief
    return isRenderableBrief(brief) ? (brief as T) : null
  } catch {
    return null
  }
}
