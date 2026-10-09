/**
 * Slows password guessing on the login route. Attempts are counted per client address and
 * username, and also per address alone with a higher limit so cycling usernames from one
 * address does not get a fresh allowance each time.
 *
 * An attempt is counted before the slow password check starts and given back on success, so
 * a burst of parallel guesses cannot all slip past the limit while the first hash is running.
 *
 * IPv6 clients are counted per /64, since one subscriber normally controls the whole prefix and
 * could otherwise rotate addresses for a fresh allowance. IPv4-mapped addresses count as IPv4.
 */
import { isIPv6 } from 'node:net'

export const LOGIN_MAX_FAILURES = 10
export const LOGIN_MAX_FAILURES_PER_ADDRESS = 50
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_TRACKED_KEYS = 5000

export type LoginThrottle = {
  /** Counts an attempt. Returns seconds to wait when it is not allowed, else 0. */
  reserve(address: string, username: string): number
  /** After a correct password: clears the pair and gives back this attempt's address count. */
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

  /** Gives back one counted attempt without touching the rest of the key's count. */
  release(key: string): void {
    const entry = this.live(key)
    if (!entry) return
    entry.count -= 1
    if (entry.count <= 0) this.entries.delete(key)
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

/** The key a client is counted under: its IPv4 address, or its IPv6 /64. Other strings pass through. */
export function throttleClientKey(address: string): string {
  const bare = address.split('%', 1)[0] ?? address
  if (!isIPv6(bare)) return address
  const groups = expandIpv6(bare)
  if (!groups) return address
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] ?? 0
    const low = groups[7] ?? 0
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
}

function expandIpv6(address: string): number[] | null {
  let text = address
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const octets = dotted[1]!.split('.').map(Number)
    if (octets.some((octet) => octet > 255)) return null
    const hex = (octets[0]! << 8) | octets[1]!
    const hex2 = (octets[2]! << 8) | octets[3]!
    text = `${text.slice(0, -dotted[1]!.length)}${hex.toString(16)}:${hex2.toString(16)}`
  }
  const [head, tail, extra] = text.split('::')
  if (extra !== undefined) return null
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 1) return null
  const parts = tail === undefined ? left : [...left, ...Array<string>(missing).fill('0'), ...right]
  const groups = parts.map((part) => Number.parseInt(part, 16))
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null
}

export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const pairs = new Counter(LOGIN_MAX_FAILURES, now)
  const addresses = new Counter(LOGIN_MAX_FAILURES_PER_ADDRESS, now)

  return {
    reserve(rawAddress, username) {
      const address = throttleClientKey(rawAddress)
      const pairKey = `${address}|${username}`
      const wait = Math.max(pairs.wait(pairKey), addresses.wait(address))
      if (wait > 0) return wait
      pairs.add(pairKey)
      addresses.add(address)
      return 0
    },
    recordSuccess(rawAddress, username) {
      const address = throttleClientKey(rawAddress)
      pairs.remove(`${address}|${username}`)
      // The attempt was counted up front; a correct password should not use up the address allowance.
      addresses.release(address)
    },
  }
}
