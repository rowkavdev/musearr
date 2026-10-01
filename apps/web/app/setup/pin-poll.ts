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
