import { afterEach, describe, expect, it, vi } from 'vitest'
import { LidarrClient } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const client = (body: string) => {
  vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }))
  return new LidarrClient('http://lidarr.test:8686', 'key')
}

describe('null JSON bodies', () => {
  it.each(['null', ''])('systemStatus reports INVALID_RESPONSE for %j', async (body) => {
    await expect(client(body).systemStatus()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each(['null', ''])('addArtist reports INVALID_RESPONSE for %j', async (body) => {
    await expect(client(body).addArtist({} as never)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each(['null', '', '"x"', '7'])('getQueue reports INVALID_RESPONSE for %j instead of a TypeError', async (body) => {
    await expect(client(body).getQueue()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('getQueue still reads a normal page and a bare array', async () => {
    expect(await client('{"records":[{"id":1,"status":"downloading"}],"totalRecords":1}').getQueue()).toHaveLength(1)
    expect(await client('[{"id":2}]').getQueue()).toHaveLength(1)
  })
  it('list endpoints skip null rows', async () => {
    expect(await client('[null]').rootFolders()).toEqual([])
    expect(await client('[null]').getArtists()).toEqual([])
    expect(await client('[null]').qualityProfiles()).toEqual([])
  })
})
