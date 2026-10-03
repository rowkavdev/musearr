import { afterEach, expect, it, vi } from 'vitest'
import { PlexClient } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const track = (Genre: unknown) => ({
  ratingKey: 1,
  title: 'Song',
  parentRatingKey: 2,
  parentTitle: 'Album',
  grandparentRatingKey: 3,
  grandparentTitle: 'Artist',
  Genre,
})

function serve(Genre: unknown) {
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ MediaContainer: { totalSize: 1, Metadata: [track(Genre)] } })),
  )
  return new PlexClient('http://plex.test:32400', 'tok')
}

it('skips a null entry in a track Genre list instead of throwing', async () => {
  const page = await serve([{ tag: 'Rock' }, null, { tag: ' Jazz ' }]).libraryTracks('1', 0, 50)
  expect(page.items[0]?.genres).toEqual(['Rock', 'Jazz'])
})

it('treats a Genre value that is not a list as no genres', async () => {
  const page = await serve({ tag: 'Rock' }).libraryTracks('1', 0, 50)
  expect(page.items[0]?.genres).toEqual([])
})
