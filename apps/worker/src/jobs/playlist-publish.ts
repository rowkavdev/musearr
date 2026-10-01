import type { MusearrConfig } from '@musearr/config'
import { decryptSecret } from '@musearr/core'
import {
  getGenerationItemStateCounts,
  getLibrarySyncSources,
  getOrphanedPlexPlaylistKey,
  getPlaylistGenerationJobContext,
  getPublishableGenerationItems,
  linkManagedPlexPlaylist,
  markGenerationItemsPublished,
  recordPlaylistPublication,
  setPlaylistGenerationStatus,
  type Database,
  type PlaylistGenerationStatus,
} from '@musearr/db'
import { PlexClient } from '@musearr/plex'

async function playlistTrackKeys(client: PlexClient, playlistRatingKey: string): Promise<Set<string>> {
  const keys = new Set<string>()
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.playlistItems(playlistRatingKey, offset, pageSize)
    for (const item of page.items) keys.add(item.plexTrackRatingKey)
    if (page.scanned < pageSize || offset + page.scanned >= page.total) return keys
  }
}

export type PlaylistPublishOutcome = {
  created: boolean
  added: number
  status: PlaylistGenerationStatus
}

/**
 * Publishes a generation to Plex as a Musearr-managed playlist. Additive and
 * idempotent: only items that carry a Plex rating key and have not been
 * published yet are sent, so a retry after a partial failure resumes cleanly
 * and never touches a user's own playlist.
 */
export async function publishPlaylistToPlex(
  database: Database,
  config: MusearrConfig,
  generationId: string,
): Promise<PlaylistPublishOutcome> {
  const context = await getPlaylistGenerationJobContext(database, generationId)
  if (!context) {
    throw new Error('The playlist generation no longer exists.')
  }
  if (!context.publishToPlex) {
    return { created: false, added: 0, status: context.status }
  }
  if (!config.MUSEARR_ENCRYPTION_KEY) {
    throw new Error('MUSEARR_ENCRYPTION_KEY is required before a Plex playlist can be written.')
  }

  const [source] = await getLibrarySyncSources(database)
  if (!source) {
    throw new Error('No Plex music library is connected, so the playlist cannot be published.')
  }

  await setPlaylistGenerationStatus(database, generationId, 'publishing')

  const client = new PlexClient(
    source.baseUrl,
    decryptSecret(source.tokenCiphertext, config.MUSEARR_ENCRYPTION_KEY),
  )
  let items = await getPublishableGenerationItems(database, generationId)
  let ratingKeys = items.map((item) => item.plexRatingKey)

  let plexPlaylistRatingKey = context.plexPlaylistRatingKey
  let created = false

  try {
    if (ratingKeys.length > 0) {
      ;({ ratingKey: plexPlaylistRatingKey, items } = await resolveTargetPlaylist(
        database,
        client,
        generationId,
        source.plexServerId,
        plexPlaylistRatingKey,
        items,
      ))
      ratingKeys = items.map((item) => item.plexRatingKey)
    }
    if (!plexPlaylistRatingKey) {
      if (ratingKeys.length === 0) {
        await setPlaylistGenerationStatus(database, generationId, 'ready')
        return { created: false, added: 0, status: 'ready' }
      }
      // Plex has no ownership marker. A same-title playlist may belong to
      // the user, so only a rating key already linked to this generation is
      // safe to append to. Find an unused title for every first publish.
      const title = await unusedPlaylistTitle(client, context.name)
      const result = await client.createAudioPlaylist(source.machineIdentifier, title, ratingKeys)
      plexPlaylistRatingKey = result.plexRatingKey
      created = true
      await linkManagedPlexPlaylist(database, {
        generationId,
        plexServerId: source.plexServerId,
        plexRatingKey: plexPlaylistRatingKey,
        name: title,
      })
    } else if (ratingKeys.length > 0) {
      await appendMissingTracks(client, plexPlaylistRatingKey, source.machineIdentifier, ratingKeys)
    }
  } catch (error) {
    await recordPlaylistPublication(database, {
      generationId,
      plexServerId: source.plexServerId,
      plexPlaylistRatingKey,
      requestedItemCount: ratingKeys.length,
      publishedItemCount: 0,
      status: 'failed',
      errorSummary: error instanceof Error ? error.message : 'unknown',
    })
    throw error
  }

  await markGenerationItemsPublished(
    database,
    items.map((item) => item.id),
  )

  const counts = await getGenerationItemStateCounts(database, generationId)
  const inFlight = counts.pending + counts.requested + counts.downloading + counts.imported
  const status: PlaylistGenerationStatus =
    inFlight > 0 ? 'awaiting_acquisition' : counts.unavailable > 0 ? 'partially_published' : 'published'
  await setPlaylistGenerationStatus(database, generationId, status)

  await recordPlaylistPublication(database, {
    generationId,
    plexServerId: source.plexServerId,
    plexPlaylistRatingKey,
    requestedItemCount: ratingKeys.length,
    publishedItemCount: ratingKeys.length,
    status: 'completed',
  })

  return { created, added: ratingKeys.length, status }
}

type PublishItems = Awaited<ReturnType<typeof getPublishableGenerationItems>>

/**
 * Picks the Plex playlist to publish into. A generation with no link may have an unlinked
 * playlist from a failed first publish. A link whose playlist the owner deleted in Plex is
 * dropped: appending to it would fail every retry as a misleading outage. The replacement then
 * starts empty, so it gets the tracks published earlier too.
 */
async function resolveTargetPlaylist(
  database: Database,
  client: PlexClient,
  generationId: string,
  plexServerId: string,
  linkedKey: string | null,
  items: PublishItems,
): Promise<{ ratingKey: string | null; items: PublishItems }> {
  if (!linkedKey) {
    return { ratingKey: await adoptOrphanedPlaylist(database, client, generationId, plexServerId), items }
  }
  const playlists = await client.audioPlaylists()
  if (playlists.some((playlist) => playlist.plexRatingKey === linkedKey)) {
    return { ratingKey: linkedKey, items }
  }
  // A replacement may already exist from a run that created it but failed to link it.
  const adopted = await adoptOrphanedPlaylist(database, client, generationId, plexServerId, linkedKey)
  return { ratingKey: adopted, items: await getPublishableGenerationItems(database, generationId, true) }
}

async function unusedPlaylistTitle(client: PlexClient, name: string): Promise<string> {
  let title = name
  for (let suffix = 1; await client.findAudioPlaylistByTitle(title); suffix += 1) {
    title = `${name} (Musearr${suffix === 1 ? '' : ` ${suffix}`})`
  }
  return title
}

/**
 * A failed first publish may have created the playlist in Plex without
 * linking it. Link that playlist so a retry does not create a second one.
 * Returns its rating key, or null when there is nothing to adopt.
 */
async function adoptOrphanedPlaylist(
  database: Database,
  client: PlexClient,
  generationId: string,
  plexServerId: string,
  staleRatingKey: string | null = null,
): Promise<string | null> {
  const orphanKey = await getOrphanedPlexPlaylistKey(database, generationId, staleRatingKey)
  if (!orphanKey) {
    return null
  }
  const orphan = (await client.audioPlaylists()).find((playlist) => playlist.plexRatingKey === orphanKey)
  if (!orphan) {
    return null
  }
  await linkManagedPlexPlaylist(database, {
    generationId,
    plexServerId,
    plexRatingKey: orphan.plexRatingKey,
    name: orphan.title,
  })
  return orphan.plexRatingKey
}

/**
 * A retry after a failed bookkeeping write finds some tracks already in the
 * playlist; Plex would append them a second time.
 */
async function appendMissingTracks(
  client: PlexClient,
  playlistRatingKey: string,
  machineIdentifier: string,
  ratingKeys: string[],
): Promise<void> {
  const present = await playlistTrackKeys(client, playlistRatingKey)
  const missing = ratingKeys.filter((key) => !present.has(key))
  if (missing.length > 0) {
    await client.addPlaylistItems(playlistRatingKey, machineIdentifier, missing)
  }
}
