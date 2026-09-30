import type { MusearrConfig } from '@musearr/config'
import { decryptSecret } from '@musearr/core'
import {
  getGenerationIdsAwaitingAcquisition,
  getGenerationItemsByState,
  getGenerationItemStateCounts,
  getLidarrConnection,
  getPlaylistGenerationJobContext,
  matchGenerationItemsInLibrary,
  setPlaylistGenerationStatus,
  updateGenerationItemAcquisition,
  type Database,
} from '@musearr/db'
import { LidarrClient, type LidarrQueueRecord, type LidarrTrackFile } from '@musearr/lidarr'

export type PlaylistReconcileOutcome = {
  scanned: number
  matched: number
  /** Generations now ready whose owner asked for a Plex publish. */
  readyToPublish: string[]
  /** Generations with pending items, retried by the scheduled sweep. */
  readyToAcquire: string[]
}

/**
 * Scheduled sweep that advances generations still waiting on acquisition.
 * Mirrors the library-sync model: Lidarr's queue/track files are hints, and a
 * track only becomes publishable once a later `library.sync` has mirrored it
 * into Plex and `matchGenerationItemsInLibrary` can attach a rating key.
 */
export async function reconcilePlaylistGenerations(
  database: Database,
  config: MusearrConfig,
): Promise<PlaylistReconcileOutcome> {
  const generationIds = await getGenerationIdsAwaitingAcquisition(database)
  const connection = await getLidarrConnection(database)
  const client =
    connection && config.MUSEARR_ENCRYPTION_KEY
      ? new LidarrClient(
          connection.baseUrl,
          decryptSecret(connection.apiKeyCiphertext, config.MUSEARR_ENCRYPTION_KEY),
        )
      : null

  let matched = 0
  const readyToPublish: string[] = []
  const readyToAcquire: string[] = []

  for (const generationId of generationIds) {
    if (client) {
      await advanceInFlightItems(database, client, generationId)
    }
    matched += await matchGenerationItemsInLibrary(database, generationId)

    const counts = await getGenerationItemStateCounts(database, generationId)
    const inFlight = counts.pending + counts.requested + counts.downloading + counts.imported
    if (inFlight > 0) {
      if (counts.pending > 0 && client) readyToAcquire.push(generationId)
      await setPlaylistGenerationStatus(database, generationId, 'awaiting_acquisition')
      continue
    }

    await setPlaylistGenerationStatus(database, generationId, 'ready')
    const context = await getPlaylistGenerationJobContext(database, generationId)
    if (context?.publishToPlex) {
      readyToPublish.push(generationId)
    }
  }

  return { scanned: generationIds.length, matched, readyToPublish, readyToAcquire }
}

async function advanceInFlightItems(
  database: Database,
  client: LidarrClient,
  generationId: string,
): Promise<void> {
  const items = await getGenerationItemsByState(database, generationId, ['requested', 'downloading'])
  if (items.length === 0) {
    return
  }

  const artistIds = [...new Set(items.map((item) => item.lidarrArtistId).filter((id): id is number => id !== null))]
  const trackFilesByArtist = new Map<number, LidarrTrackFile[]>()
  for (const artistId of artistIds) {
    try {
      trackFilesByArtist.set(artistId, await client.getTrackFiles(artistId))
    } catch {
      trackFilesByArtist.set(artistId, [])
    }
  }

  let queue: LidarrQueueRecord[] = []
  try {
    queue = await client.getQueue()
  } catch {
    queue = []
  }

  for (const item of items) {
    if (item.lidarrArtistId === null) {
      continue
    }
    const files = trackFilesByArtist.get(item.lidarrArtistId) ?? []
    const hasFile = files.some(
      (file) => item.lidarrAlbumId === null || file.albumId === item.lidarrAlbumId,
    )
    if (hasFile) {
      await updateGenerationItemAcquisition(database, item.id, { state: 'imported' })
      continue
    }
    const downloading = queue.some(
      (record) => record.artistId === item.lidarrArtistId && isActiveDownload(record.status),
    )
    if (downloading) {
      await updateGenerationItemAcquisition(database, item.id, { state: 'downloading' })
    }
  }
}

function isActiveDownload(status: string): boolean {
  const normalised = status.toLowerCase()
  return normalised === 'downloading' || normalised === 'queued' || normalised === 'paused'
}
