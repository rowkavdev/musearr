import { describe, expect, it } from 'vitest'
import { PIN_POLL_MAX_FAILURES, shouldRetryPinPoll } from './pin-poll'

describe('shouldRetryPinPoll', () => {
  it('retries network errors and server errors', () => {
    expect(shouldRetryPinPoll(null, 1)).toBe(true)
    expect(shouldRetryPinPoll(502, 1)).toBe(true)
    expect(shouldRetryPinPoll(503, 3)).toBe(true)
  })

  it('stops on errors that retrying cannot fix', () => {
    expect(shouldRetryPinPoll(404, 1)).toBe(false)
    expect(shouldRetryPinPoll(400, 1)).toBe(false)
  })

  it('gives up after repeated failures', () => {
    expect(shouldRetryPinPoll(502, PIN_POLL_MAX_FAILURES)).toBe(false)
    expect(shouldRetryPinPoll(null, PIN_POLL_MAX_FAILURES + 1)).toBe(false)
  })
})
