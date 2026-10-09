import { describe, expect, it } from 'vitest'
import {
  createLoginThrottle,
  LOGIN_MAX_FAILURES,
  LOGIN_MAX_FAILURES_PER_ADDRESS,
  LOGIN_WINDOW_MS,
} from './login-throttle.js'

describe('login throttle', () => {
  it('limits a pair after too many attempts and releases it when the window passes', () => {
    let time = 1_000
    const throttle = createLoginThrottle(() => time)
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect(throttle.reserve('a', 'owner')).toBe(0)
    expect(throttle.reserve('a', 'owner')).toBeGreaterThan(0)
    expect(throttle.reserve('b', 'owner')).toBe(0)
    time += LOGIN_WINDOW_MS
    expect(throttle.reserve('a', 'owner')).toBe(0)
  })

  it('clears the pair after a successful login', () => {
    const throttle = createLoginThrottle(() => 0)
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) throttle.reserve('a', 'owner')
    throttle.recordSuccess('a', 'owner')
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect(throttle.reserve('a', 'owner')).toBe(0)
  })

  it('stops one address from cycling usernames for a fresh allowance each time', () => {
    const throttle = createLoginThrottle(() => 0)
    let allowed = 0
    for (let i = 0; i < 500; i++) if (throttle.reserve('attacker', `user${i}`) === 0) allowed += 1
    expect(allowed).toBe(LOGIN_MAX_FAILURES_PER_ADDRESS)
    expect(throttle.reserve('someone-else', 'owner')).toBe(0)
  })

  it('refuses new keys instead of tracking nothing when every tracked key is limited', () => {
    const throttle = createLoginThrottle(() => 0)
    for (let i = 0; i < 5000; i++) {
      for (let n = 0; n < LOGIN_MAX_FAILURES; n++) throttle.reserve(`addr${i}`, 'owner')
    }
    expect(throttle.reserve('fresh', 'owner')).toBeGreaterThan(0)
    expect(throttle.reserve('addr0', 'owner')).toBeGreaterThan(0)
  })

  it('does not spend the address allowance on successful logins', () => {
    const throttle = createLoginThrottle(() => 0)
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_ADDRESS * 3; i++) {
      expect(throttle.reserve('home', 'owner')).toBe(0)
      throttle.recordSuccess('home', 'owner')
    }
    expect(throttle.reserve('home', 'someone')).toBe(0)
  })

  it('keeps failures from other usernames on the address when one login succeeds', () => {
    const throttle = createLoginThrottle(() => 0)
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_ADDRESS - 1; i++) throttle.reserve('home', `guess${i}`)
    expect(throttle.reserve('home', 'owner')).toBe(0)
    throttle.recordSuccess('home', 'owner')
    // 49 failures remain, so exactly one more attempt fits before the address limit.
    expect(throttle.reserve('home', 'next')).toBe(0)
    expect(throttle.reserve('home', 'after')).toBeGreaterThan(0)
  })

  it('shares one allowance across every address in an IPv6 /64', () => {
    const throttle = createLoginThrottle(() => 0)
    let allowed = 0
    for (let i = 0; i < 200; i++) {
      for (let n = 0; n < LOGIN_MAX_FAILURES; n++) {
        if (throttle.reserve(`2001:db8:1234:5678::${(i + 1).toString(16)}`, 'owner') === 0) allowed += 1
      }
    }
    expect(allowed).toBe(LOGIN_MAX_FAILURES)
    // A different /64 and a plain IPv4 address are unaffected.
    expect(throttle.reserve('2001:db8:1234:5679::1', 'owner')).toBe(0)
    expect(throttle.reserve('203.0.113.9', 'owner')).toBe(0)
  })

  it('treats compressed, zoned and uppercase forms of one /64 as the same client', () => {
    const throttle = createLoginThrottle(() => 0)
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) throttle.reserve('2001:db8:0:0:1::1', 'owner')
    expect(throttle.reserve('2001:DB8::2', 'owner')).toBeGreaterThan(0)
    expect(throttle.reserve('2001:db8::3%eth0', 'owner')).toBeGreaterThan(0)
  })

  it('counts IPv4-mapped IPv6 addresses as the IPv4 address', () => {
    const throttle = createLoginThrottle(() => 0)
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) throttle.reserve('203.0.113.9', 'owner')
    expect(throttle.reserve('::ffff:203.0.113.9', 'owner')).toBeGreaterThan(0)
    expect(throttle.reserve('::ffff:cb00:7109', 'owner')).toBeGreaterThan(0)
    expect(throttle.reserve('::ffff:203.0.113.10', 'owner')).toBe(0)
  })

  it('releases the shared /64 address count on success', () => {
    const throttle = createLoginThrottle(() => 0)
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_ADDRESS * 3; i++) {
      expect(throttle.reserve(`2001:db8::${(i + 1).toString(16)}`, 'owner')).toBe(0)
      throttle.recordSuccess(`2001:db8::${(i + 1).toString(16)}`, 'owner')
    }
  })
})
