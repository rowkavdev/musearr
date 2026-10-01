import { afterEach, expect, it, vi } from 'vitest'
import { PlexClient } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each([
  ['204', () => new Response(null, { status: 204 })],
  ['200 empty', () => new Response('', { status: 200 })],
] as const)('createAudioPlaylist reports INVALID_RESPONSE for an %s reply', async (_label, make) => {
  vi.stubGlobal('fetch', async () => make())
  const client = new PlexClient('http://plex.test:32400', 'tok')
  await expect(client.createAudioPlaylist('machine', 'Mix', ['10'])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
