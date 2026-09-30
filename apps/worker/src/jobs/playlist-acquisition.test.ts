import { randomBytes } from 'node:crypto'
import { encryptSecret } from '@musearr/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getGenerationItemsByState: vi.fn(),
  getGenerationItemStateCounts: vi.fn(),
  getLidarrConnection: vi.fn(),
  setPlaylistGenerationStatus: vi.fn(async () => undefined),
  updateGenerationItemAcquisition: vi.fn(async () => undefined),
}))
const lidarr = vi.hoisted(() => ({
  lookupArtist: vi.fn(),
  addArtist: vi.fn(),
  getArtists: vi.fn(),
  getAlbums: vi.fn(),
}))
vi.mock('@musearr/db', () => db)
vi.mock('@musearr/lidarr', () => ({ LidarrClient: vi.fn(function LidarrClient() { return lidarr }) }))
const { requestPlaylistAcquisitions } = await import('./playlist-acquisition.js')
const encryptionKey = randomBytes(32).toString('base64')
const config = { MUSEARR_ENCRYPTION_KEY: encryptionKey } as never
const database = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  db.getGenerationItemsByState.mockResolvedValue([{ id: 'item-1', artistName: 'Nirvana', albumTitle: null }])
  db.getLidarrConnection.mockResolvedValue({ baseUrl: 'http://lidarr.local', apiKeyCiphertext: encryptSecret('test-key', encryptionKey), rootFolderPath: '/music', qualityProfileId: 1, metadataProfileId: 2 })
  db.getGenerationItemStateCounts.mockResolvedValue({ pending: 0, requested: 0, downloading: 0, imported: 0, unavailable: 1 })
  lidarr.getArtists.mockResolvedValue([])
  lidarr.addArtist.mockResolvedValue({ id: 42, artistName: 'Nirvana' })
})

describe('requestPlaylistAcquisitions artist matching', () => {
  it('skips an unrelated first hit and adds the exact requested artist', async () => {
    lidarr.lookupArtist.mockResolvedValue([
      { foreignArtistId: 'wrong', artistName: 'Nirvana (60s UK band)' },
      { foreignArtistId: 'right', artistName: 'Nirvana' },
    ])
    expect(await requestPlaylistAcquisitions(database, config, 'gen-1')).toEqual({ requested: 1, unavailable: 0 })
    expect(lidarr.addArtist).toHaveBeenCalledWith(expect.objectContaining({ foreignArtistId: 'right', artistName: 'Nirvana' }))
  })

  it('never adds a nonmatching artist when there is no exact hit', async () => {
    lidarr.lookupArtist.mockResolvedValue([{ foreignArtistId: 'wrong', artistName: 'Nirvana (60s UK band)' }])
    expect(await requestPlaylistAcquisitions(database, config, 'gen-1')).toEqual({ requested: 0, unavailable: 1 })
    expect(lidarr.addArtist).not.toHaveBeenCalled()
  })

  it('does not pick an arbitrary already-added artist with a duplicate name', async () => {
    lidarr.getArtists.mockResolvedValue([
      { id: 20, foreignArtistId: 'one', artistName: 'Nirvana' },
      { id: 42, foreignArtistId: 'two', artistName: 'Nirvana' },
    ])
    expect(await requestPlaylistAcquisitions(database, config, 'gen-1')).toEqual({ requested: 0, unavailable: 1 })
    expect(lidarr.lookupArtist).not.toHaveBeenCalled()
    expect(lidarr.addArtist).not.toHaveBeenCalled()
  })

  it('does not guess between distinct artists with the same exact name', async () => {
    lidarr.lookupArtist.mockResolvedValue([
      { foreignArtistId: 'one', artistName: 'Nirvana' },
      { foreignArtistId: 'two', artistName: 'Nirvana' },
    ])
    expect(await requestPlaylistAcquisitions(database, config, 'gen-1')).toEqual({ requested: 0, unavailable: 1 })
    expect(lidarr.addArtist).not.toHaveBeenCalled()
  })
})
