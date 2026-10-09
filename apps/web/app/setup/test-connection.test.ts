import { describe, expect, it, vi } from 'vitest'
import { runConnectionTest, type VerifiedConnection } from './test-connection'

const SERVER_A = { baseUrl: 'http://server-a:32400', token: 'token-a' }

const CONNECTION_A: VerifiedConnection = {
  machineIdentifier: 'machine-a',
  serverName: 'Server A',
  version: '1.41',
  musicLibraries: [{ id: '1', title: 'Music', type: 'artist' }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness() {
  const generation = { current: 0 }
  const captured = generation.current
  const onVerified = vi.fn()
  const onFailure = vi.fn()
  const readIssue = vi.fn(async () => 'Plex rejected those details.')
  return {
    isCurrent: () => captured === generation.current,
    bumpGeneration: () => {
      generation.current += 1
    },
    onVerified,
    onFailure,
    readIssue,
  }
}

describe('runConnectionTest', () => {
  it('applies a success while the tested details are still current', async () => {
    const { promise, resolve } = deferred<Response>()
    const tools = harness()
    const run = runConnectionTest({
      fetchImpl: (() => promise) as unknown as typeof fetch,
      details: SERVER_A,
      isCurrent: tools.isCurrent,
      readIssue: tools.readIssue,
      onVerified: tools.onVerified,
      onFailure: tools.onFailure,
    })
    resolve(Response.json(CONNECTION_A))
    await run
    expect(tools.onVerified).toHaveBeenCalledWith(CONNECTION_A)
    expect(tools.onFailure).not.toHaveBeenCalled()
  })

  it('drops a success that returns after the address was edited during the test', async () => {
    const { promise, resolve } = deferred<Response>()
    const tools = harness()
    const run = runConnectionTest({
      fetchImpl: (() => promise) as unknown as typeof fetch,
      details: SERVER_A,
      isCurrent: tools.isCurrent,
      readIssue: tools.readIssue,
      onVerified: tools.onVerified,
      onFailure: tools.onFailure,
    })
    tools.bumpGeneration()
    resolve(Response.json(CONNECTION_A))
    await run
    expect(tools.onVerified).not.toHaveBeenCalled()
    expect(tools.onFailure).not.toHaveBeenCalled()
  })

  it('drops a success that returns after the token was replaced by a Plex sign-in', async () => {
    const { promise, resolve } = deferred<Response>()
    const tools = harness()
    const run = runConnectionTest({
      fetchImpl: (() => promise) as unknown as typeof fetch,
      details: SERVER_A,
      isCurrent: tools.isCurrent,
      readIssue: tools.readIssue,
      onVerified: tools.onVerified,
      onFailure: tools.onFailure,
    })
    tools.bumpGeneration()
    resolve(Response.json(CONNECTION_A))
    await run
    expect(tools.onVerified).not.toHaveBeenCalled()
  })

  it('shows the failure message while the tested details are still current', async () => {
    const { promise, resolve } = deferred<Response>()
    const tools = harness()
    const run = runConnectionTest({
      fetchImpl: (() => promise) as unknown as typeof fetch,
      details: SERVER_A,
      isCurrent: tools.isCurrent,
      readIssue: tools.readIssue,
      onVerified: tools.onVerified,
      onFailure: tools.onFailure,
    })
    resolve(new Response('nope', { status: 401 }))
    await run
    expect(tools.onFailure).toHaveBeenCalledWith('Plex rejected those details.')
    expect(tools.onVerified).not.toHaveBeenCalled()
  })

  it('drops a failure that returns after the details were edited during the test', async () => {
    const { promise, resolve } = deferred<Response>()
    const tools = harness()
    const run = runConnectionTest({
      fetchImpl: (() => promise) as unknown as typeof fetch,
      details: SERVER_A,
      isCurrent: tools.isCurrent,
      readIssue: tools.readIssue,
      onVerified: tools.onVerified,
      onFailure: tools.onFailure,
    })
    tools.bumpGeneration()
    resolve(new Response('nope', { status: 401 }))
    await run
    expect(tools.onFailure).not.toHaveBeenCalled()
    expect(tools.onVerified).not.toHaveBeenCalled()
  })
})
