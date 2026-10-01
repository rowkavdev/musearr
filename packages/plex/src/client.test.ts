import { createServer } from 'node:http'
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

  it('rejects link-local and cloud metadata hosts but keeps LAN and loopback (#83)', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.1.1:32400',
      'http://[fe80::1]:32400',
      'http://[::ffff:169.254.169.254]/',
      'http://metadata.google.internal/',
    ]) {
      expect(() => normalisePlexBaseUrl(url), url).toThrow(PlexConnectionError)
    }
    expect(normalisePlexBaseUrl('http://192.168.1.20:32400')).toBe('http://192.168.1.20:32400')
    expect(normalisePlexBaseUrl('http://127.0.0.1:32400')).toBe('http://127.0.0.1:32400')
    expect(normalisePlexBaseUrl('http://[::1]:32400')).toBe('http://[::1]:32400')
  })

  it('rejects the Alibaba, AWS IPv6 and short Google metadata endpoints (#83)', () => {
    for (const url of ['http://100.100.100.200/latest/meta-data', 'http://[fd00:ec2::254]/latest', 'http://metadata.goog/', 'http://metadata.google.internal./', 'http://[::ffff:100.100.100.200]/', 'http://[::ffff:169.254.169.254]:32400']) {
      expect(() => normalisePlexBaseUrl(url), url).toThrow(PlexConnectionError)
    }
    expect(normalisePlexBaseUrl('http://100.64.0.5:32400')).toBe('http://100.64.0.5:32400')
    expect(normalisePlexBaseUrl('http://[::ffff:192.168.1.20]:32400')).toBe('http://[::ffff:c0a8:114]:32400')
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


it('does not forward plex credentials to a redirect target (#73)', async () => {
  let targetRequests = 0
  const target = createServer((_request, response) => { targetRequests++; response.setHeader('content-type', 'application/json'); response.end('{}') })
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
  const targetPort = (target.address() as { port: number }).port
  const source = createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/target` }); response.end() })
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
  const sourcePort = (source.address() as { port: number }).port
  try {
    await new PlexClient(`http://127.0.0.1:${sourcePort}`, 'fixture-secret').testConnection().catch(() => {})
    expect(targetRequests).toBe(0)
  } finally {
    source.closeAllConnections(); target.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))])
  }
})

it('preserves fractional Plex user ratings during library import', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ MediaContainer: { Metadata: [{
    ratingKey: 1, title: 'Track', parentRatingKey: 2, parentTitle: 'Album', grandparentRatingKey: 3, grandparentTitle: 'Artist', userRating: 8.5,
  }] } })));
  const page = await new PlexClient('http://plex.local', 'test-token').libraryTracks('4', 0, 200);
  expect(page.items[0]?.rating).toBe(8.5);
});

it.each([-1, 11, '8.5', null])('drops invalid Plex rating %s without losing the track', async (userRating) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ MediaContainer: { Metadata: [{
    ratingKey: 1, title: 'Track', parentRatingKey: 2, parentTitle: 'Album', grandparentRatingKey: 3, grandparentTitle: 'Artist', userRating,
  }] } })));
  const page = await new PlexClient('http://plex.local', 'test-token').libraryTracks('4', 0, 200);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.rating).toBeNull();
});
