import { describe, expect, it } from 'vitest'
import { loginFailureMessage } from './login-error'

describe('loginFailureMessage', () => {
  it('only blames the credentials when the server said they were wrong', () => {
    expect(loginFailureMessage(401, null)).toBe('The local owner name or password is not correct.')
    expect(loginFailureMessage(500, null)).not.toMatch(/not correct/)
    expect(loginFailureMessage(503, null)).not.toMatch(/not correct/)
  })

  it('says when to retry after the server throttled the login', () => {
    expect(loginFailureMessage(429, '600')).toBe('Too many sign-in attempts. Try again in 10 minutes.')
    expect(loginFailureMessage(429, '30')).toBe('Too many sign-in attempts. Try again in 1 minute.')
    expect(loginFailureMessage(429, null)).toBe('Too many sign-in attempts. Try again in a few minutes.')
    expect(loginFailureMessage(429, 'soon')).toBe('Too many sign-in attempts. Try again in a few minutes.')
  })
})
