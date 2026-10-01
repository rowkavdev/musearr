/**
 * Slows password guessing on the login route. Attempts are counted per client address and
 * username, and also per address alone with a higher limit so cycling usernames from one
 * address does not get a fresh allowance each time.
 *
 * An attempt is counted before the slow password check starts and given back on success, so
 * a burst of parallel guesses cannot all slip past the limit while the first hash is running.
 */
export const LOGIN_MAX_FAILURES = 10
export const LOGIN_MAX_FAILURES_PER_ADDRESS = 50
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_TRACKED_KEYS = 5000

export type LoginThrottle = {
  /** Counts an attempt. Returns seconds to wait when it is not allowed, else 0. */
  reserve(address: string, username: string): number
  /** Clears the address and username pair after a correct password. */
  recordSuccess(address: string, username: string): void
}

type Entry = { count: number; firstAt: number }

class Counter {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  /** Seconds to wait if the key is already at its limit, without counting anything. */
  wait(key: string): number {
    const entry = this.live(key)
    if (entry && entry.count >= this.limit) return this.remaining(entry)
    if (!entry && this.entries.size >= MAX_TRACKED_KEYS && !this.makeRoom()) {
      // Every tracked key is limited and nothing can be evicted safely: refuse new keys.
      return this.soonestExpiry()
    }
    return 0
  }

  add(key: string): void {
    const entry = this.live(key)
    if (entry) entry.count += 1
    else this.entries.set(key, { count: 1, firstAt: this.now() })
  }

  remove(key: string): void {
    this.entries.delete(key)
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key)
    if (entry && this.now() - entry.firstAt >= LOGIN_WINDOW_MS) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  private remaining(entry: Entry): number {
    return Math.max(1, Math.ceil((entry.firstAt + LOGIN_WINDOW_MS - this.now()) / 1000))
  }

  private soonestExpiry(): number {
    let soonest = LOGIN_WINDOW_MS / 1000
    for (const entry of this.entries.values()) soonest = Math.min(soonest, this.remaining(entry))
    return soonest
  }

  private makeRoom(): boolean {
    let oldestUnderLimit: string | undefined
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.firstAt >= LOGIN_WINDOW_MS) {
        this.entries.delete(key)
        return true
      }
      if (oldestUnderLimit === undefined && entry.count < this.limit) oldestUnderLimit = key
    }
    if (oldestUnderLimit === undefined) return false
    this.entries.delete(oldestUnderLimit)
    return true
  }
}

export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const pairs = new Counter(LOGIN_MAX_FAILURES, now)
  const addresses = new Counter(LOGIN_MAX_FAILURES_PER_ADDRESS, now)

  return {
    reserve(address, username) {
      const pairKey = `${address}|${username}`
      const wait = Math.max(pairs.wait(pairKey), addresses.wait(address))
      if (wait > 0) return wait
      pairs.add(pairKey)
      addresses.add(address)
      return 0
    },
    recordSuccess(address, username) {
      pairs.remove(`${address}|${username}`)
    },
  }
}
