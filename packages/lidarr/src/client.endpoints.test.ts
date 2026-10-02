import { afterEach, describe, expect, it, vi } from 'vitest'
import { LidarrClient } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
      return Response.json(handler(url, init) as never)
    }),
  )
  return calls
}

const client = () => new LidarrClient('http://lidarr.local', 'api-key-value')

describe('LidarrClient endpoints', () => {
  it('drops root folders without an id or path', async () => {
    stubFetch(() => [
      { id: 1, path: '/music', freeSpace: 500 },
      { id: 2 },
      { path: '/no-id' },
    ])
    await expect(client().rootFolders()).resolves.toEqual([{ id: 1, path: '/music', freeSpaceBytes: 500 }])
  })

  it('url-encodes the artist lookup term and keeps only usable results', async () => {
    const calls = stubFetch(() => [
      { foreignArtistId: 'mb-1', artistName: 'Sigur Rós', disambiguation: 'Icelandic', overview: 'Band' },
      { artistName: 'No id' },
    ])
    const found = await client().lookupArtist('Sigur Rós & Co')
    expect(calls[0]!.url).toContain('/api/v1/artist/lookup?term=Sigur%20R%C3%B3s%20%26%20Co')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ foreignArtistId: 'mb-1', artistName: 'Sigur Rós' })
  })

  it('posts a new artist monitored, without searching for missing albums', async () => {
    const calls = stubFetch(() => ({ id: 7, foreignArtistId: 'mb-1', artistName: 'Sigur Rós' }))
    const artist = await client().addArtist({
      foreignArtistId: 'mb-1',
      artistName: 'Sigur Rós',
      qualityProfileId: 1,
      metadataProfileId: 2,
      rootFolderPath: '/music',
    })
    expect(artist.id).toBe(7)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { monitored: true, addOptions: { monitor: 'all', searchForMissingAlbums: false }, rootFolderPath: '/music' },
    })
  })

  it('rejects an add response it cannot read as an artist', async () => {
    stubFetch(() => ({ unexpected: true }))
    await expect(
      client().addArtist({ foreignArtistId: 'x', artistName: 'X', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/m' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('lists an artist\'s albums and falls back to the requested artist id', async () => {
    const calls = stubFetch(() => [
      { id: 10, title: 'Ágætis byrjun', monitored: true, foreignAlbumId: 'fa-1' },
      { id: 11, title: '( )', artistId: 9 },
      { title: 'no id' },
    ])
    const albums = await client().getAlbums(7)
    expect(calls[0]!.url).toContain('/api/v1/album?artistId=7')
    expect(albums).toEqual([
      { id: 10, foreignAlbumId: 'fa-1', title: 'Ágætis byrjun', monitored: true, artistId: 7 },
      { id: 11, foreignAlbumId: '', title: '( )', monitored: false, artistId: 9 },
    ])
  })

  it('makes no request when there are no albums to monitor or search', async () => {
    const calls = stubFetch(() => ({}))
    await client().setAlbumsMonitored([], true)
    await client().searchAlbums([])
    expect(calls).toHaveLength(0)
  })

  it('sends monitor and search requests with the album ids', async () => {
    const calls = stubFetch(() => ({}))
    await client().setAlbumsMonitored([1, 2], true)
    await client().searchAlbums([3])
    expect(calls[0]).toMatchObject({ method: 'PUT', url: expect.stringContaining('/api/v1/album/monitor'), body: { albumIds: [1, 2], monitored: true } })
    expect(calls[1]).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/v1/command'), body: { name: 'AlbumSearch', albumIds: [3] } })
  })
})
