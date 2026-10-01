/** What to tell the owner when the login request did not succeed. */
export function loginFailureMessage(status: number, retryAfter: string | null): string {
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? '', 10)
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60)
      return `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
    }
    return 'Too many sign-in attempts. Try again in a few minutes.'
  }
  if (status === 401) return 'The local owner name or password is not correct.'
  if (status === 403) return 'Open Musearr from its own address to sign in.'
  return 'Musearr could not sign you in right now. Try again shortly.'
}
