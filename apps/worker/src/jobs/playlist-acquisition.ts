import type { MusearrConfig } from '@musearr/config'
import { decryptSecret } from '@musearr/core'
import {
  getGenerationItemsByState,
  getGenerationItemStateCounts,
  getLidarrConnection,
  setPlaylistGenerationStatus,
  updateGenerationItemAcquisition,
  type Database,
} from '@musearr/db'
import { LidarrClient, LidarrConnectionError } from '@musearr/lidarr'

export type PlaylistAcquisitionOutcome = {
  requested: number
  unavailable: number
}

/**
 * Asks Lidarr to acquire the "gap" tracks in a generation. Each item is handled
 * independently: confirmed lookup misses are `unavailable`; a transient
 * Lidarr outage stays pending for the scheduled reconciler to retry. The
 * reconciler later advances `requested` items
 * as their files import and Plex mirrors them.
 */
export async function requestPlaylistAcquisitions(
  database: Database,
  config: MusearrConfig,
  generationId: string,
): Promise<PlaylistAcquisitionOutcome> {
  const pendingItems = await getGenerationItemsByState(database, generationId, ['pending'])
  if (pendingItems.length === 0) {
    await refreshGenerationStatus(database, generationId)
    return { requested: 0, unavailable: 0 }
  }

  const connection = await getLidarrConnection(database)
  if (!connection) {
    for (const item of pendingItems) {
      await updateGenerationItemAcquisition(database, item.id, { state: 'unavailable' })
    }
    await refreshGenerationStatus(database, generationId)
    return { requested: 0, unavailable: pendingItems.length }
  }

  if (!config.MUSEARR_ENCRYPTION_KEY) {
    throw new Error('MUSEARR_ENCRYPTION_KEY is required before Lidarr acquisition can run.')
  }

  const client = new LidarrClient(
    connection.baseUrl,
    decryptSecret(connection.apiKeyCiphertext, config.MUSEARR_ENCRYPTION_KEY),
  )
  const defaults = await resolveAddDefaults(client, connection)
  const knownArtists = new Map<string, Array<{ id: number; foreignArtistId: string }>>()
  for (const artist of await client.getArtists()) {
    const name = artist.artistName.trim().toLowerCase()
    knownArtists.set(name, [...(knownArtists.get(name) ?? []), artist])
  }

  let requested = 0
  let unavailable = 0
  for (const item of pendingItems) {
    try {
      const artistId = await ensureArtist(client, knownArtists, item.artistName, defaults)
      if (artistId === null) {
        await updateGenerationItemAcquisition(database, item.id, { state: 'unavailable' })
        unavailable += 1
        continue
      }

      const albumId = item.albumTitle ? await findAlbumId(client, artistId, item.albumTitle) : null
      if (albumId !== null) {
        await client.setAlbumsMonitored([albumId], true)
        await client.searchAlbums([albumId])
      }
      await updateGenerationItemAcquisition(database, item.id, {
        state: 'requested',
        lidarrArtistId: artistId,
        lidarrAlbumId: albumId,
      })
      requested += 1
    } catch (error) {
      // A transport outage is not evidence that the artist is unavailable.
      if (error instanceof LidarrConnectionError && error.code === 'UNREACHABLE') continue
      await updateGenerationItemAcquisition(database, item.id, { state: 'unavailable' })
      unavailable += 1
    }
  }

  await refreshGenerationStatus(database, generationId)
  return { requested, unavailable }
}

async function resolveAddDefaults(
  client: LidarrClient,
  connection: Awaited<ReturnType<typeof getLidarrConnection>>,
): Promise<{ rootFolderPath: string; qualityProfileId: number; metadataProfileId: number }> {
  const rootFolderPath =
    connection?.rootFolderPath ?? (await client.rootFolders())[0]?.path ?? null
  const qualityProfileId =
    connection?.qualityProfileId ?? (await client.qualityProfiles())[0]?.id ?? null
  const metadataProfileId =
    connection?.metadataProfileId ?? (await client.metadataProfiles())[0]?.id ?? null

  if (rootFolderPath === null || qualityProfileId === null || metadataProfileId === null) {
    throw new Error('Lidarr is missing a root folder or quality/metadata profile for new artists.')
  }
  return { rootFolderPath, qualityProfileId, metadataProfileId }
}

async function ensureArtist(
  client: LidarrClient,
  knownArtists: Map<string, Array<{ id: number; foreignArtistId: string }>>,
  artistName: string,
  defaults: { rootFolderPath: string; qualityProfileId: number; metadataProfileId: number },
): Promise<number | null> {
  const existing = knownArtists.get(artistName.trim().toLowerCase())
  if (existing?.length) {
    // Two artists can have the same display name but different MusicBrainz IDs.
    return existing.length === 1 ? existing[0]!.id : null
  }

  // Lookup order is relevance, not identity. Shared artist names can still
  // refer to different MusicBrainz artists, so require one exact-name match.
  const target = artistName.trim().toLowerCase()
  const matches = (await client.lookupArtist(artistName)).filter(
    (artist) => artist.artistName.trim().toLowerCase() === target,
  )
  const match = matches[0]
  if (matches.length !== 1 || !match) return null
  const added = await client.addArtist({
    foreignArtistId: match.foreignArtistId,
    artistName: match.artistName,
    rootFolderPath: defaults.rootFolderPath,
    qualityProfileId: defaults.qualityProfileId,
    metadataProfileId: defaults.metadataProfileId,
    monitored: true,
  })
  knownArtists.set(match.artistName.trim().toLowerCase(), [added])
  return added.id
}

async function findAlbumId(client: LidarrClient, artistId: number, albumTitle: string): Promise<number | null> {
  const target = albumTitle.trim().toLowerCase()
  const albums = await client.getAlbums(artistId)
  const matches = albums.filter((album) => album.title.trim().toLowerCase() === target)
  // Title is not album identity: distinct releases can have the same title.
  return matches.length === 1 ? matches[0]!.id : null
}

async function refreshGenerationStatus(database: Database, generationId: string): Promise<void> {
  const counts = await getGenerationItemStateCounts(database, generationId)
  const inFlight = counts.pending + counts.requested + counts.downloading + counts.imported
  await setPlaylistGenerationStatus(database, generationId, inFlight > 0 ? 'awaiting_acquisition' : 'ready')
}
