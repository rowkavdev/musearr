import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlexClient } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('empty or null JSON bodies on GET', () => {
  for (const [label, make] of [
    ['204', () => new Response(null, { status: 204 })],
    ['200 empty', () => new Response('', { status: 200 })],
    ['200 null', () => new Response('null', { status: 200 })],
  ] as const) {
    it(`audioPlaylists reports INVALID_RESPONSE for ${label}`, async () => {
      vi.stubGlobal('fetch', async () => make())
      const client = new PlexClient('http://plex.test:32400', 'tok')
      await expect(client.audioPlaylists()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })
  }

  it.each([
    ['204', () => new Response(null, { status: 204 })],
    ['200 empty', () => new Response('', { status: 200 })],
  ] as const)('mutations still resolve on an %s response', async (_label, make) => {
    vi.stubGlobal('fetch', async () => make())
    const client = new PlexClient('http://plex.test:32400', 'tok')
    await expect(client.addPlaylistItems('1', 'machine', ['10'])).resolves.toBeUndefined()
  })
})
