/** Consecutive failed checks tolerated before Plex sign-in is reported as failed. */
export const PIN_POLL_MAX_FAILURES = 5

/**
 * Whether a failed sign-in status check is worth another try. Network errors (status null) and
 * server or plex.tv errors (5xx) are usually brief; a 4xx means the request itself is wrong.
 */
export function shouldRetryPinPoll(status: number | null, consecutiveFailures: number): boolean {
  if (consecutiveFailures >= PIN_POLL_MAX_FAILURES) return false
  return status === null || status >= 500
}

export const PIN_REQUEST_TIMEOUT_MS = 10_000

type PinStatusShape = { authToken: string | null; servers: Array<{ name: string; machineIdentifier: string; baseUrl: string }> }

/** True when the body has the shape the API promises, so a null or HTML-ish reply never counts as a good check. */
export function isPinStatus(value: unknown): value is PinStatusShape {
  if (typeof value !== 'object' || value === null) return false
  const { authToken, servers } = value as { authToken?: unknown; servers?: unknown }
  if (authToken !== null && typeof authToken !== 'string') return false
  if (!Array.isArray(servers)) return false
  return servers.every((server) => {
    if (typeof server !== 'object' || server === null) return false
    const { name, machineIdentifier, baseUrl } = server as Record<string, unknown>
    return typeof name === 'string' && typeof machineIdentifier === 'string' && typeof baseUrl === 'string'
  })
}

export type PinCheck<T> = { ok: true; value: T } | { ok: false; status: number | null; message: string | null }

/**
 * One sign-in status check. A hung request is abandoned after the timeout, and a 200 whose body
 * is not valid JSON, or not the expected shape (null, wrong field types), counts as a failed check.
 */
export async function checkPinStatus(
  fetchImpl: typeof fetch,
  url: string,
  readIssue: (response: Response) => Promise<string>,
  timeoutMs: number = PIN_REQUEST_TIMEOUT_MS,
): Promise<PinCheck<PinStatusShape>> {
  let response: Response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { ok: false, status: null, message: null }
  }
  if (!response.ok) {
    return { ok: false, status: response.status, message: await readIssue(response) }
  }
  try {
    const body: unknown = await response.json()
    if (!isPinStatus(body)) return { ok: false, status: null, message: null }
    return { ok: true, value: body }
  } catch {
    return { ok: false, status: null, message: null }
  }
}
