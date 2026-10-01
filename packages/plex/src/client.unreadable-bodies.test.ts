import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlexClient, checkPlexPin, createPlexPin, listPlexServersForToken } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const reply = (body: string) => vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }))

describe('plex.tv replies that are not the expected shape', () => {
  it.each(['null', '7', '"x"', '{}'])('createPlexPin reports INVALID_RESPONSE for %j', async (body) => {
    reply(body)
    await expect(createPlexPin()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each(['null', '7', '"x"'])('checkPlexPin reports INVALID_RESPONSE for %j', async (body) => {
    reply(body)
    await expect(checkPlexPin(1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each(['null', '{"error":"x"}', '"x"'])('listPlexServersForToken reports INVALID_RESPONSE for %j', async (body) => {
    reply(body)
    await expect(listPlexServersForToken('tok')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('listPlexServersForToken skips null entries instead of throwing', async () => {
    reply(JSON.stringify([null, { provides: 'server', name: 'Home', clientIdentifier: 'abc', connections: [{ uri: 'http://10.0.0.2:32400', local: true }] }]))
    await expect(listPlexServersForToken('tok')).resolves.toEqual([{ name: 'Home', machineIdentifier: 'abc', baseUrl: 'http://10.0.0.2:32400' }])
  })
  it('createPlexPin and checkPlexPin still read normal replies', async () => {
    reply('{"id":5,"code":"ABCD","authToken":null}')
    await expect(createPlexPin()).resolves.toEqual({ id: 5, code: 'ABCD', authToken: null })
    reply('{"authToken":"secret"}')
    await expect(checkPlexPin(5)).resolves.toEqual({ authToken: 'secret' })
  })
})

describe('createPlaylist when Plex answers the POST with an empty body', () => {
  it('reports INVALID_RESPONSE instead of a TypeError', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request) =>
      String(input).includes('/identity')
        ? new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'm1' } }), { status: 200 })
        : new Response('', { status: 200 }),
    )
    const client = new PlexClient('http://plex.test:32400', 'tok')
    await expect(client.createPlaylist('Mix', ['1'])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
