export const SYNC_POLL_INTERVAL_MS = 10_000

type SyncStatus = 'not_started' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

// The sync card promises to refresh while a sync is waiting or running.
export function shouldPollSync(status: SyncStatus | undefined): boolean {
  return status === 'queued' || status === 'running'
}

// A refresh only replaces what is on screen when it is a usable overview with a sync block.
export async function readOverviewRefresh<T extends { sync: unknown }>(
  reply: { ok: boolean; json: () => Promise<unknown> },
): Promise<T | null> {
  try {
    if (!reply.ok) return null
    const body = (await reply.json()) as T | null
    return body && typeof body === 'object' && body.sync && typeof body.sync === 'object' ? body : null
  } catch {
    return null
  }
}

// Skip a tick while the previous poll is still out or nobody can see the page.
export function shouldPollNow(inFlight: boolean, hidden: boolean): boolean {
  return !inFlight && !hidden
}

// A 401 mid-poll means the session ended; the card would otherwise sit on stale data.
export function pollSessionEnded(reply: { status: number }): boolean {
  return reply.status === 401
}
