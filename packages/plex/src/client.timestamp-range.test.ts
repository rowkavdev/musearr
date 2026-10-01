import { afterEach, expect, it, vi } from 'vitest'
import { PlexClient } from './client.js'

afterEach(() => vi.unstubAllGlobals())

it('drops unrepresentable optional track timestamps without losing the page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ MediaContainer: { Metadata: [{
    ratingKey: '1', title: 'Track', parentRatingKey: '2', parentTitle: 'Album', grandparentRatingKey: '3', grandparentTitle: 'Artist',
    addedAt: 1e20, updatedAt: -1e20, lastViewedAt: Number.MAX_VALUE,
  }] } })))
  const page = await new PlexClient('http://plex.local', 'token').libraryTracks('4', 0, 200)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({ addedAt: null, plexUpdatedAt: null, lastPlayedAt: null })
})

it('drops unrepresentable playlist revision and item timestamps', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ MediaContainer: { Metadata: [{ ratingKey: '1', title: 'Mix', playlistType: 'audio', updatedAt: 1e20 }] } }))
    .mockResolvedValueOnce(Response.json({ MediaContainer: { Metadata: [{ ratingKey: '10', addedAt: 1e20 }] } })))
  const client = new PlexClient('http://plex.local', 'token')
  await expect(client.audioPlaylists()).resolves.toEqual([{ plexRatingKey: '1', title: 'Mix', revision: null }])
  await expect(client.playlistItems('1', 0, 200)).resolves.toMatchObject({ items: [{ plexTrackRatingKey: '10', addedAt: null }] })
})

it.each([0, 1_700_000_000, 8_640_000_000_000, -8_640_000_000_000])('keeps representable timestamp %s', async addedAt => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ MediaContainer: { Metadata: [{ ratingKey: '10', addedAt }] } })))
  const page = await new PlexClient('http://plex.local', 'token').playlistItems('1', 0, 200)
  expect(page.items[0]?.addedAt).toBe(new Date(addedAt * 1_000).toISOString())
})
