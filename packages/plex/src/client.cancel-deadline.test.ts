import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlexClient } from './client.js'
import { LidarrClient } from '../../lidarr/src/client.js'

const limit = 16 * 1024 * 1024

afterEach(() => vi.unstubAllGlobals())

for (const provider of ['Plex', 'Lidarr']) {
  describe(`${provider} oversize cleanup`, () => {
    it.each(['declared', 'streamed'])('rejects %s oversize without waiting on stream cancellation', async (mode) => {
      const cancel = vi.fn(() => new Promise<void>(() => {}))
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'streamed') controller.enqueue(new Uint8Array(limit + 1))
        },
        cancel,
      }), { headers: mode === 'declared' ? { 'content-length': String(limit + 1) } : {} })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      const operation = provider === 'Plex'
        ? new PlexClient('http://localhost:32400', 'test').libraryTracks('1', 0, 200)
        : new LidarrClient('http://localhost:8686', 'test').systemStatus()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          operation.then(() => 'resolved', (error: unknown) => error),
          new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), 100) }),
        ])
        expect(outcome).toMatchObject({ code: 'INVALID_RESPONSE', message: `${provider} response exceeds the 16 MiB limit.` })
        expect(cancel).toHaveBeenCalledTimes(1)
      } finally {
        clearTimeout(timer)
      }
    })
  })
}
