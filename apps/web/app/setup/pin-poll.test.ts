import { describe, expect, it } from 'vitest'
import { checkPinStatus, PIN_POLL_MAX_FAILURES, shouldRetryPinPoll } from './pin-poll'

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

describe('checkPinStatus', () => {
  const readIssue = async () => 'issue'
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('returns the parsed body on success', async () => {
    const result = await checkPinStatus(async () => json({ authToken: 'x', servers: [] }), '/pin/1', readIssue)
    expect(result).toEqual({ ok: true, value: { authToken: 'x', servers: [] } })
  })

  it('counts a 200 with an invalid body as a failed check', async () => {
    const result = await checkPinStatus(async () => new Response('<html>oops</html>', { status: 200 }), '/pin/1', readIssue)
    expect(result).toEqual({ ok: false, status: null, message: null })
  })

  it('reports the status and message of an error response', async () => {
    const result = await checkPinStatus(async () => json({ detail: 'x' }, 502), '/pin/1', readIssue)
    expect(result).toEqual({ ok: false, status: 502, message: 'issue' })
  })

  it('gives up on a request that never answers', async () => {
    const hung: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const result = await checkPinStatus(hung, '/pin/1', readIssue, 20)
    expect(result).toEqual({ ok: false, status: null, message: null })
  })

  it.each([
    ['null', 'null'],
    ['a string', '"ok"'],
    ['a missing servers list', '{"authToken":null}'],
    ['a numeric authToken', '{"authToken":5,"servers":[]}'],
    ['a malformed server record', '{"authToken":null,"servers":[{"name":1}]}'],
  ])('counts %s as a failed check, not a good one', async (_label, body) => {
    const result = await checkPinStatus(async () => new Response(body, { status: 200 }), '/pin/1', readIssue)
    expect(result.ok).toBe(false)
  })

  it('accepts a pending sign-in and a signed-in reply with servers', async () => {
    const pending = await checkPinStatus(async () => json({ authToken: null, servers: [] }), '/pin/1', readIssue)
    const done = await checkPinStatus(
      async () => json({ authToken: 't', servers: [{ name: 'Plex', machineIdentifier: 'm', baseUrl: 'http://plex:32400' }] }),
      '/pin/1',
      readIssue,
    )
    expect(pending.ok).toBe(true)
    expect(done.ok).toBe(true)
  })
})
