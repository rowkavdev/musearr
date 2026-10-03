import { afterEach, expect, it, vi } from 'vitest'
import { PlexClient } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('skips a null entry in the library sections list instead of throwing a TypeError', async () => {
  vi.stubGlobal('fetch', async (url: string) =>
    new Response(
      JSON.stringify(
        String(url).includes('/library/sections')
          ? { MediaContainer: { Directory: [null, { type: 'artist', key: '1', title: 'Music' }] } }
          : { MediaContainer: { machineIdentifier: 'm', version: '1' } },
      ),
    ),
  )
  const client = new PlexClient('http://plex.test:32400', 'tok')
  const result = await client.testConnection()
  expect(result.machineIdentifier).toBe('m')
})
