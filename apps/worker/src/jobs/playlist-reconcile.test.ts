import { randomBytes } from 'node:crypto'
import { encryptSecret } from '@musearr/core'
import { beforeEach, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getGenerationIdsAwaitingAcquisition: vi.fn(),
  getGenerationItemsByState: vi.fn(),
  getGenerationItemStateCounts: vi.fn(),
  getLidarrConnection: vi.fn(),
  getPlaylistGenerationJobContext: vi.fn(),
  matchGenerationItemsInLibrary: vi.fn(),
  setPlaylistGenerationStatus: vi.fn(),
  updateGenerationItemAcquisition: vi.fn(),
  expireStalledGenerationItems: vi.fn(),
}))
vi.mock('@musearr/db', () => db)
const lidarr = vi.hoisted(() => ({ getTrackFiles: vi.fn(), getQueue: vi.fn() }))
vi.mock('@musearr/lidarr', () => ({ LidarrClient: vi.fn(function LidarrClient() { return lidarr }) }))
const { reconcilePlaylistGenerations } = await import('./playlist-reconcile.js')
const encryptionKey = randomBytes(32).toString('base64')
const config = { MUSEARR_ENCRYPTION_KEY: encryptionKey } as never
const database = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  lidarr.getTrackFiles.mockResolvedValue([])
  lidarr.getQueue.mockResolvedValue([])
  db.getGenerationIdsAwaitingAcquisition.mockResolvedValue(['gen-1'])
  db.getGenerationItemsByState.mockResolvedValue([])
  db.getGenerationItemStateCounts.mockResolvedValue({ pending: 1, requested: 0, downloading: 0, imported: 0, unavailable: 0 })
  db.getLidarrConnection.mockResolvedValue({ baseUrl: 'http://lidarr.local', apiKeyCiphertext: encryptSecret('test-key', encryptionKey) })
  db.matchGenerationItemsInLibrary.mockResolvedValue(0)
})

it('schedules a retry for pending items in the ten-minute reconciliation sweep', async () => {
  expect(await reconcilePlaylistGenerations(database, config)).toEqual({
    scanned: 1, matched: 0, readyToPublish: [], readyToAcquire: ['gen-1'],
  })
  expect(db.setPlaylistGenerationStatus).toHaveBeenCalledWith(database, 'gen-1', 'awaiting_acquisition')
})

const item = { id: 'item', lidarrArtistId: 5, lidarrAlbumId: null }
it('does not import unrelated artist files when the target album is unknown', async () => {
  db.getGenerationItemsByState.mockResolvedValue([item])
  lidarr.getTrackFiles.mockResolvedValue([{ artistId: 5, albumId: 99 }])
  await reconcilePlaylistGenerations(database, config)
  expect(db.updateGenerationItemAcquisition).not.toHaveBeenCalled()
})
it('does not treat paused or other-album downloads as progress', async () => {
  db.getGenerationItemsByState.mockResolvedValue([{ ...item, lidarrAlbumId: 4 }])
  lidarr.getQueue.mockResolvedValue([{ artistId: 5, albumId: 4, status: 'paused' }, { artistId: 5, albumId: 99, status: 'downloading' }])
  await reconcilePlaylistGenerations(database, config)
  expect(db.updateGenerationItemAcquisition).not.toHaveBeenCalled()
})
it('advances only the specific album with import evidence', async () => {
  db.getGenerationItemsByState.mockResolvedValue([{ ...item, lidarrAlbumId: 4 }])
  lidarr.getTrackFiles.mockResolvedValue([{ artistId: 5, albumId: 4 }])
  await reconcilePlaylistGenerations(database, config)
  expect(db.updateGenerationItemAcquisition).toHaveBeenCalledWith(database, 'item', { state: 'imported' })
})
it('matches Plex first, then expires stalled items even without Lidarr', async () => {
  db.getLidarrConnection.mockResolvedValue(null)
  db.getGenerationItemStateCounts.mockResolvedValue({ pending: 0, requested: 0, downloading: 0, imported: 0, unavailable: 1 })
  await reconcilePlaylistGenerations(database, config)
  expect(db.expireStalledGenerationItems).toHaveBeenCalledWith(database, 'gen-1')
  expect(db.matchGenerationItemsInLibrary.mock.invocationCallOrder[0]).toBeLessThan(db.expireStalledGenerationItems.mock.invocationCallOrder[0]!)
  expect(db.setPlaylistGenerationStatus).toHaveBeenCalledWith(database, 'gen-1', 'ready')
})
