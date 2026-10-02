type BriefReply = { ok: boolean; json: () => Promise<unknown> } | null

// The daily brief is optional on the home page, so any bad reply reads as "no brief".
export async function readDailyBrief<T>(reply: BriefReply | Promise<BriefReply>): Promise<T | null> {
  try {
    const response = await reply
    if (!response?.ok) return null
    const payload = (await response.json()) as { brief?: T | null } | null
    return payload?.brief ?? null
  } catch {
    return null
  }
}
