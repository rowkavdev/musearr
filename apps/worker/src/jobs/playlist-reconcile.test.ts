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
}))
vi.mock('@musearr/db', () => db)
vi.mock('@musearr/lidarr', () => ({ LidarrClient: vi.fn(function LidarrClient() { return {} }) }))
const { reconcilePlaylistGenerations } = await import('./playlist-reconcile.js')
const encryptionKey = randomBytes(32).toString('base64')
const config = { MUSEARR_ENCRYPTION_KEY: encryptionKey } as never
const database = {} as never

beforeEach(() => {
  vi.clearAllMocks()
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
