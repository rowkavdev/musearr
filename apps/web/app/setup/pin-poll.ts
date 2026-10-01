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

export type PinCheck<T> = { ok: true; value: T } | { ok: false; status: number | null; message: string | null }

/**
 * One sign-in status check. A hung request is abandoned after the timeout, and a 200 whose body
 * is not valid JSON counts as a failed check rather than a good one.
 */
export async function checkPinStatus<T>(
  fetchImpl: typeof fetch,
  url: string,
  readIssue: (response: Response) => Promise<string>,
  timeoutMs: number = PIN_REQUEST_TIMEOUT_MS,
): Promise<PinCheck<T>> {
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
    return { ok: true, value: (await response.json()) as T }
  } catch {
    return { ok: false, status: null, message: null }
  }
}
