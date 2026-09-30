import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlexClient, PlexConnectionError, normalisePlexBaseUrl } from './client.js'

afterEach(() => vi.unstubAllGlobals())

describe('normalisePlexBaseUrl', () => {
  it('removes a trailing slash but preserves a valid Plex origin', () => {
    expect(normalisePlexBaseUrl('http://plex.local:32400/')).toBe('http://plex.local:32400')
  })

  it('rejects embedded credentials and unsupported protocols', () => {
    expect(() => normalisePlexBaseUrl('https://user:pass@plex.local')).toThrow(PlexConnectionError)
    expect(() => normalisePlexBaseUrl('ftp://plex.local')).toThrow(PlexConnectionError)
  })

  it('maps Plex track pages while retaining source identifiers and optional playback fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            MediaContainer: {
              totalSize: 1,
              Metadata: [
                {
                  ratingKey: 17,
                  title: 'Teardrop',
                  index: 1,
                  parentIndex: 1,
                  duration: 331000,
                  addedAt: 1_700_000_000,
                  updatedAt: 1_700_000_100,
                  viewCount: 9,
                  lastViewedAt: 1_700_100_000,
                  userRating: 9,
                  parentRatingKey: 12,
                  parentTitle: 'Mezzanine',
                  parentYear: 1998,
                  grandparentRatingKey: 7,
                  grandparentTitle: 'Massive Attack',
                  Genre: [{ tag: 'Trip Hop' }],
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )

    const page = await new PlexClient('http://plex.local:32400', 'test-token').libraryTracks('4', 0, 200)

    expect(page).toMatchObject({ total: 1, offset: 0, scanned: 1, skipped: 0 })
    expect(page.items).toEqual([
      expect.objectContaining({
        plexRatingKey: '17',
        title: 'Teardrop',
        playCount: 9,
        artist: expect.objectContaining({ plexRatingKey: '7', name: 'Massive Attack' }),
        album: expect.objectContaining({ plexRatingKey: '12', title: 'Mezzanine', year: 1998 }),
        genres: ['Trip Hop'],
      }),
    ])
  })

  it('maps audio playlists and paged playlist items without assuming every item resolves', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                { ratingKey: 41, title: 'Long drives', playlistType: 'audio', updatedAt: 1_700_000_100 },
                { ratingKey: 42, title: 'Video playlist', playlistType: 'video' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            MediaContainer: {
              totalSize: 2,
              Metadata: [{ ratingKey: 17, addedAt: 1_700_000_000 }, { title: 'Unresolvable item' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetch)

    const client = new PlexClient('http://plex.local:32400', 'test-token')
    await expect(client.audioPlaylists()).resolves.toEqual([
      { plexRatingKey: '41', title: 'Long drives', revision: '2023-11-14T22:15:00.000Z' },
    ])
    await expect(client.playlistItems('41', 0, 200)).resolves.toEqual({
      total: 2,
      offset: 0,
      scanned: 2,
      skipped: 1,
      items: [{ plexTrackRatingKey: '17', addedAt: '2023-11-14T22:13:20.000Z' }],
    })
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://plex.local:32400/playlists/41/items?X-Plex-Container-Start=0&X-Plex-Container-Size=200',
      expect.any(Object),
    )
  })
})


describe('PlexClient bounded responses', () => {
  const client = () => new PlexClient('http://plex.local', 'test-secret')
  const limit = 16 * 1024 * 1024

  it('rejects declared overflow without consuming the body', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.close() } }), {
      headers: { 'content-length': String(limit + 1) },
    })
    const cancel = vi.spyOn(response.body!, 'cancel')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(client().libraryTracks("4", 0, 200)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([undefined, '0', '2'])('caps streamed bytes even with declared length %s', async (length) => {
    const cancel = vi.fn()
    let chunks = 0
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (chunks >= 18) { controller.close(); return }
        chunks++
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32))
      },
      cancel,
    }), { headers: length === undefined ? {} : { 'content-length': length } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(client().libraryTracks("4", 0, 200)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(chunks).toBeLessThanOrEqual(18)
  })
  it('accepts exactly the limit and decodes split UTF-8 correctly', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({'MediaContainer': {}, 'instanceName': 'Björk', 'version': '1'}))
    const split = payload.indexOf(195) + 1
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(payload.slice(0, split))
        controller.enqueue(payload.slice(split))
        controller.enqueue(new Uint8Array(limit - payload.length).fill(32))
        controller.close()
      },
    }))))
    const result = await client().libraryTracks("4", 0, 200)
    expect(result).toBeDefined()

  })

})
