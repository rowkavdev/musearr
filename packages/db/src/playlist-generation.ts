import type { Database } from './repository.js'

export type PlaylistGenerationStatus =
  | 'generating'
  | 'awaiting_acquisition'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'partially_published'
  | 'failed'

export type PlaylistGenerationItemState =
  | 'in_library'
  | 'pending'
  | 'requested'
  | 'downloading'
  | 'imported'
  | 'matched'
  | 'unavailable'

export type PlaylistLibraryTrackRecord = {
  trackId: string
  plexRatingKey: string
  artistId: string
  artistName: string
  albumId: string
  albumTitle: string
  trackTitle: string
  genres: string[]
  year: number | null
  rating: number | null
  playCount: number
  lastPlayedAt: string | null
}

export type LidarrConnectionRow = {
  baseUrl: string
  apiKeyCiphertext: string
  instanceName: string | null
  version: string | null
  rootFolderPath: string | null
  qualityProfileId: number | null
  metadataProfileId: number | null
  lastCheckedAt: string | null
}

export type LidarrConnectionStatusRecord = {
  configured: boolean
  baseUrl: string | null
  instanceName: string | null
  version: string | null
  rootFolderPath: string | null
  qualityProfileId: number | null
  metadataProfileId: number | null
  lastCheckedAt: string | null
}

export type UpsertLidarrConnection = {
  baseUrl: string
  apiKeyCiphertext: string
  instanceName: string | null
  version: string | null
  rootFolderPath: string | null
  qualityProfileId: number | null
  metadataProfileId: number | null
}

export type CreatePlaylistGeneration = {
  userId: string
  seedTrackId: string
  seedLabel: string
  name: string
  algorithmVersion: string
  targetSize: number
  acquireMissing: boolean
  publishToPlex: boolean
}

export type PlaylistGenerationItemInput = {
  position: number
  trackId: string | null
  plexRatingKey: string | null
  artistName: string
  albumTitle: string | null
  trackTitle: string
  state: PlaylistGenerationItemState
  score: number
  reasonCodes: unknown[]
}

export type PlaylistGenerationItemRecord = {
  id: string
  position: number
  trackId: string | null
  trackTitle: string
  artistName: string
  albumTitle: string | null
  state: PlaylistGenerationItemState
  inLibrary: boolean
  score: number
  reasons: unknown[]
}

export type PlaylistGenerationRecord = {
  id: string
  name: string
  seedTrackId: string | null
  seedLabel: string
  status: PlaylistGenerationStatus
  algorithmVersion: string
  targetSize: number
  acquireMissing: boolean
  publishToPlex: boolean
  counts: {
    total: number
    inLibrary: number
    awaitingAcquisition: number
    unavailable: number
    published: number
  }
  plexPlaylistRatingKey: string | null
  errorSummary: string | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  items: PlaylistGenerationItemRecord[]
}

export type PlaylistGenerationSummaryRecord = Omit<PlaylistGenerationRecord, 'items'>

const IN_FLIGHT_STATES: PlaylistGenerationItemState[] = ['pending', 'requested', 'downloading', 'imported']

export async function getLidarrConnection(database: Database): Promise<LidarrConnectionRow | null> {
  const rows = await database<
    Array<{
      base_url: string
      api_key_ciphertext: string
      instance_name: string | null
      version: string | null
      root_folder_path: string | null
      quality_profile_id: number | null
      metadata_profile_id: number | null
      last_checked_at: Date | string | null
    }>
  >`
    SELECT base_url, api_key_ciphertext, instance_name, version,
           root_folder_path, quality_profile_id, metadata_profile_id, last_checked_at
    FROM lidarr_connections
    LIMIT 1
  `
  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    baseUrl: row.base_url,
    apiKeyCiphertext: row.api_key_ciphertext,
    instanceName: row.instance_name,
    version: row.version,
    rootFolderPath: row.root_folder_path,
    qualityProfileId: row.quality_profile_id,
    metadataProfileId: row.metadata_profile_id,
    lastCheckedAt: serialiseTimestamp(row.last_checked_at),
  }
}

export async function getLidarrConnectionStatus(database: Database): Promise<LidarrConnectionStatusRecord> {
  const connection = await getLidarrConnection(database)
  if (!connection) {
    return {
      configured: false,
      baseUrl: null,
      instanceName: null,
      version: null,
      rootFolderPath: null,
      qualityProfileId: null,
      metadataProfileId: null,
      lastCheckedAt: null,
    }
  }
  return {
    configured: true,
    baseUrl: connection.baseUrl,
    instanceName: connection.instanceName,
    version: connection.version,
    rootFolderPath: connection.rootFolderPath,
    qualityProfileId: connection.qualityProfileId,
    metadataProfileId: connection.metadataProfileId,
    lastCheckedAt: connection.lastCheckedAt,
  }
}

export async function upsertLidarrConnection(
  database: Database,
  input: UpsertLidarrConnection,
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`DELETE FROM lidarr_connections`
    await transaction`
      INSERT INTO lidarr_connections (
        base_url, api_key_ciphertext, instance_name, version,
        root_folder_path, quality_profile_id, metadata_profile_id, last_checked_at
      ) VALUES (
        ${input.baseUrl},
        ${input.apiKeyCiphertext},
        ${input.instanceName},
        ${input.version},
        ${input.rootFolderPath},
        ${input.qualityProfileId},
        ${input.metadataProfileId},
        NOW()
      )
    `
  })
}

export async function markLidarrConnectionChecked(
  database: Database,
  patch: { version: string | null; instanceName: string | null },
): Promise<void> {
  await database`
    UPDATE lidarr_connections
    SET version = COALESCE(${patch.version}, version),
        instance_name = COALESCE(${patch.instanceName}, instance_name),
        last_checked_at = NOW(),
        updated_at = NOW()
  `
}

export async function getPlaylistLibraryTracks(
  database: Database,
  userId: string,
): Promise<PlaylistLibraryTrackRecord[]> {
  const rows = await database<
    Array<{
      track_id: string
      plex_rating_key: string
      artist_id: string
      artist_name: string
      album_id: string
      album_title: string
      track_title: string
      genres: string[] | null
      year: number | null
      rating: string | number | null
      play_count: number | null
      last_played_at: Date | string | null
    }>
  >`
    SELECT
      t.id AS track_id,
      t.plex_rating_key,
      artist.id AS artist_id,
      artist.name AS artist_name,
      album.id AS album_id,
      album.title AS album_title,
      t.title AS track_title,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT genre.display_name), NULL) AS genres,
      album.year,
      state.rating,
      state.play_count,
      state.last_played_at
    FROM tracks t
    JOIN albums album ON album.id = t.album_id
    JOIN artists artist ON artist.id = album.artist_id
    LEFT JOIN user_item_state state
      ON state.entity_type = 'track' AND state.entity_id = t.id AND state.user_id = ${userId}
    LEFT JOIN item_genres item_genre
      ON item_genre.entity_type = 'track' AND item_genre.entity_id = t.id
    LEFT JOIN genres genre ON genre.id = item_genre.genre_id
    GROUP BY
      t.id, t.plex_rating_key, artist.id, artist.name, album.id, album.title,
      t.title, album.year, state.rating, state.play_count, state.last_played_at
    ORDER BY artist.name ASC, album.title ASC, t.id ASC
  `

  return rows.map((row) => ({
    trackId: row.track_id,
    plexRatingKey: row.plex_rating_key,
    artistId: row.artist_id,
    artistName: row.artist_name,
    albumId: row.album_id,
    albumTitle: row.album_title,
    trackTitle: row.track_title,
    genres: row.genres ?? [],
    year: row.year ?? null,
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    playCount: row.play_count ?? 0,
    lastPlayedAt: serialiseTimestamp(row.last_played_at),
  }))
}

export type PlaylistGenerationJobContext = {
  id: string
  userId: string
  seedTrackId: string | null
  name: string
  targetSize: number
  acquireMissing: boolean
  publishToPlex: boolean
  status: PlaylistGenerationStatus
  plexPlaylistRatingKey: string | null
}

export async function getPlaylistGenerationJobContext(
  database: Database,
  generationId: string,
): Promise<PlaylistGenerationJobContext | null> {
  const rows = await database<
    Array<{
      id: string
      user_id: string
      seed_track_id: string | null
      name: string
      target_size: number
      acquire_missing: boolean
      publish_to_plex: boolean
      status: PlaylistGenerationStatus
      plex_playlist_rating_key: string | null
    }>
  >`
    SELECT g.id, g.user_id, g.seed_track_id, g.name, g.target_size,
           g.acquire_missing, g.publish_to_plex, g.status,
           playlist.plex_rating_key AS plex_playlist_rating_key
    FROM playlist_generations g
    LEFT JOIN playlists playlist ON playlist.id = g.plex_playlist_id
    WHERE g.id = ${generationId}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    id: row.id,
    userId: row.user_id,
    seedTrackId: row.seed_track_id,
    name: row.name,
    targetSize: row.target_size,
    acquireMissing: row.acquire_missing,
    publishToPlex: row.publish_to_plex,
    status: row.status,
    plexPlaylistRatingKey: row.plex_playlist_rating_key,
  }
}

/** Returns an "Artist — Track" label for a mirrored track, or null if unknown. */
export async function getPlaylistSeedLabel(
  database: Database,
  trackId: string,
): Promise<string | null> {
  const rows = await database<Array<{ artist_name: string; track_title: string }>>`
    SELECT artist.name AS artist_name, t.title AS track_title
    FROM tracks t
    JOIN albums album ON album.id = t.album_id
    JOIN artists artist ON artist.id = album.artist_id
    WHERE t.id = ${trackId}
    LIMIT 1
  `
  const row = rows[0]
  return row ? `${row.artist_name} — ${row.track_title}` : null
}

export async function createPlaylistGeneration(
  database: Database,
  input: CreatePlaylistGeneration,
): Promise<string> {
  const rows = await database<Array<{ id: string }>>`
    INSERT INTO playlist_generations (
      user_id, seed_track_id, seed_label, name, status,
      algorithm_version, target_size, acquire_missing, publish_to_plex
    ) VALUES (
      ${input.userId},
      ${input.seedTrackId},
      ${input.seedLabel},
      ${input.name},
      'generating',
      ${input.algorithmVersion},
      ${input.targetSize},
      ${input.acquireMissing},
      ${input.publishToPlex}
    )
    RETURNING id
  `
  const generation = rows[0]
  if (!generation) {
    throw new Error('Failed to create the playlist generation.')
  }
  return generation.id
}

export async function replacePlaylistGenerationItems(
  database: Database,
  generationId: string,
  items: PlaylistGenerationItemInput[],
  algorithmVersion?: string,
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`DELETE FROM playlist_generation_items WHERE generation_id = ${generationId}`
    for (const item of items) {
      await transaction`
        INSERT INTO playlist_generation_items (
          generation_id, position, track_id, plex_rating_key,
          artist_name, album_title, track_title, state, score, reason_codes,
          matched_at
        ) VALUES (
          ${generationId},
          ${item.position},
          ${item.trackId},
          ${item.plexRatingKey},
          ${item.artistName},
          ${item.albumTitle},
          ${item.trackTitle},
          ${item.state},
          ${item.score},
          ${JSON.stringify(item.reasonCodes)}::jsonb,
          ${item.state === 'in_library' ? new Date().toISOString() : null}
        )
      `
    }
    await transaction`
      UPDATE playlist_generations
      SET updated_at = NOW(),
          algorithm_version = COALESCE(${algorithmVersion ?? null}, algorithm_version)
      WHERE id = ${generationId}
    `
  })
}

export async function setPlaylistGenerationStatus(
  database: Database,
  generationId: string,
  status: PlaylistGenerationStatus,
  errorSummary?: string,
): Promise<void> {
  const stampPublished = status === 'published' || status === 'partially_published'
  await database`
    UPDATE playlist_generations
    SET status = ${status},
        error_summary = ${errorSummary ? errorSummary.slice(0, 1_000) : null},
        published_at = CASE WHEN ${stampPublished} THEN COALESCE(published_at, NOW()) ELSE published_at END,
        updated_at = NOW()
    WHERE id = ${generationId}
  `
}

export async function getGenerationIdsAwaitingAcquisition(database: Database): Promise<string[]> {
  const rows = await database<Array<{ id: string }>>`
    SELECT id FROM playlist_generations
    WHERE status IN ('awaiting_acquisition', 'ready', 'publishing')
    ORDER BY created_at ASC
    LIMIT 50
  `
  return rows.map((row) => row.id)
}

export async function getGenerationItemsByState(
  database: Database,
  generationId: string,
  states: PlaylistGenerationItemState[],
): Promise<
  Array<{
    id: string
    artistName: string
    albumTitle: string | null
    trackTitle: string
    lidarrArtistId: number | null
    lidarrAlbumId: number | null
  }>
> {
  if (states.length === 0) {
    return []
  }
  const rows = await database<
    Array<{
      id: string
      artist_name: string
      album_title: string | null
      track_title: string
      lidarr_artist_id: number | null
      lidarr_album_id: number | null
    }>
  >`
    SELECT id, artist_name, album_title, track_title, lidarr_artist_id, lidarr_album_id
    FROM playlist_generation_items
    WHERE generation_id = ${generationId} AND state::text IN ${database(states)}
    ORDER BY position ASC
  `
  return rows.map((row) => ({
    id: row.id,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    trackTitle: row.track_title,
    lidarrArtistId: row.lidarr_artist_id,
    lidarrAlbumId: row.lidarr_album_id,
  }))
}

export async function updateGenerationItemAcquisition(
  database: Database,
  itemId: string,
  patch: {
    state: PlaylistGenerationItemState
    lidarrArtistId?: number | null
    lidarrAlbumId?: number | null
  },
): Promise<void> {
  await database`
    UPDATE playlist_generation_items
    SET state = ${patch.state},
        lidarr_artist_id = COALESCE(${patch.lidarrArtistId ?? null}, lidarr_artist_id),
        lidarr_album_id = COALESCE(${patch.lidarrAlbumId ?? null}, lidarr_album_id),
        acquisition_requested_at = CASE
          WHEN ${patch.state === 'requested'} THEN COALESCE(acquisition_requested_at, NOW())
          ELSE acquisition_requested_at
        END,
        updated_at = NOW()
    WHERE id = ${itemId}
  `
}

/**
 * Resolves acquired items by exact artist + title + supplied album (case-insensitive).
 * Ambiguous recordings remain unresolved rather than choosing a row arbitrarily. Returns the number of items newly matched. Idempotent:
 * an already-matched item is left untouched.
 */
export async function matchGenerationItemsInLibrary(
  database: Database,
  generationId: string,
): Promise<number> {
  const result = await database`
    UPDATE playlist_generation_items AS pgi
    SET track_id = m.track_id,
        plex_rating_key = m.plex_rating_key,
        state = 'matched',
        matched_at = NOW(),
        updated_at = NOW()
    FROM (
      SELECT candidate.id AS item_id,
             MIN(t.id::text)::uuid AS track_id,
             MIN(t.plex_rating_key) AS plex_rating_key
      FROM playlist_generation_items candidate
      JOIN artists ar ON LOWER(ar.name) = LOWER(candidate.artist_name)
      JOIN albums al ON al.artist_id = ar.id
      JOIN tracks t ON t.album_id = al.id AND LOWER(t.title) = LOWER(candidate.track_title)
      WHERE candidate.generation_id = ${generationId}
        AND candidate.track_id IS NULL
        AND candidate.state IN ('pending', 'requested', 'downloading', 'imported')
        AND (candidate.album_title IS NULL OR LOWER(candidate.album_title) = LOWER(al.title))
      GROUP BY candidate.id
      HAVING COUNT(*) = 1
    ) m
    WHERE pgi.id = m.item_id
      AND pgi.track_id IS NULL
      AND pgi.state IN ('pending', 'requested', 'downloading', 'imported')
  `
  return result.count ?? 0
}

export async function getGenerationItemStateCounts(
  database: Database,
  generationId: string,
): Promise<Record<PlaylistGenerationItemState, number>> {
  const rows = await database<Array<{ state: PlaylistGenerationItemState; count: string }>>`
    SELECT state, COUNT(*)::text AS count
    FROM playlist_generation_items
    WHERE generation_id = ${generationId}
    GROUP BY state
  `
  const counts: Record<PlaylistGenerationItemState, number> = {
    in_library: 0,
    pending: 0,
    requested: 0,
    downloading: 0,
    imported: 0,
    matched: 0,
    unavailable: 0,
  }
  for (const row of rows) {
    counts[row.state] = Number(row.count)
  }
  return counts
}

export async function getPublishableGenerationItems(
  database: Database,
  generationId: string,
  includePublished = false,
): Promise<Array<{ id: string; plexRatingKey: string; position: number }>> {
  const rows = await database<Array<{ id: string; plex_rating_key: string; position: number }>>`
    SELECT id, plex_rating_key, position
    FROM playlist_generation_items
    WHERE generation_id = ${generationId}
      AND plex_rating_key IS NOT NULL
      AND (${includePublished} OR published_at IS NULL)
    ORDER BY position ASC
  `
  return rows.map((row) => ({ id: row.id, plexRatingKey: row.plex_rating_key, position: row.position }))
}

export async function markGenerationItemsPublished(
  database: Database,
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) {
    return
  }
  await database`
    UPDATE playlist_generation_items
    SET published_at = NOW(), updated_at = NOW()
    WHERE id::text IN ${database(itemIds)}
  `
}

/**
 * Inserts (or refreshes) a Musearr-managed playlist row for a Plex playlist we
 * created, and links it to the generation. Never touches a user-owned playlist:
 * `managed_by_musearr` is always true here.
 */
export async function linkManagedPlexPlaylist(
  database: Database,
  input: { generationId: string; plexServerId: string; plexRatingKey: string; name: string },
): Promise<string> {
  return database.begin(async (transaction) => {
    const rows = await transaction<Array<{ id: string }>>`
      INSERT INTO playlists (plex_server_id, plex_rating_key, name, kind, managed_by_musearr, last_synced_at)
      VALUES (${input.plexServerId}, ${input.plexRatingKey}, ${input.name}, 'musearr', true, NOW())
      ON CONFLICT (plex_server_id, plex_rating_key)
      DO UPDATE SET name = EXCLUDED.name, managed_by_musearr = true, updated_at = NOW()
      RETURNING id
    `
    const playlist = rows[0]
    if (!playlist) {
      throw new Error('Failed to record the managed Plex playlist.')
    }
    await transaction`
      UPDATE playlist_generations
      SET plex_playlist_id = ${playlist.id}, updated_at = NOW()
      WHERE id = ${input.generationId}
    `
    return playlist.id
  })
}

/**
 * The Plex playlist a failed first publish created but never linked, if any.
 * A failed publication row keeps the created rating key, so a retry can adopt
 * that playlist instead of creating a second one.
 */
export async function getOrphanedPlexPlaylistKey(database: Database, generationId: string): Promise<string | null> {
  const rows = await database<Array<{ plex_playlist_rating_key: string | null }>>`
    SELECT publication.plex_playlist_rating_key
    FROM playlist_publications publication
    JOIN playlist_generations generation ON generation.id = publication.generation_id
    WHERE publication.generation_id = ${generationId}
      AND generation.plex_playlist_id IS NULL
      AND publication.status = 'failed'
      AND publication.plex_playlist_rating_key IS NOT NULL
    ORDER BY publication.created_at DESC
    LIMIT 1
  `
  return rows[0]?.plex_playlist_rating_key ?? null
}

export async function recordPlaylistPublication(
  database: Database,
  input: {
    generationId: string
    plexServerId: string
    plexPlaylistRatingKey: string | null
    requestedItemCount: number
    publishedItemCount: number
    status: string
    errorSummary?: string
  },
): Promise<void> {
  await database`
    INSERT INTO playlist_publications (
      generation_id, plex_server_id, plex_playlist_rating_key,
      requested_item_count, published_item_count, status, error_summary
    ) VALUES (
      ${input.generationId},
      ${input.plexServerId},
      ${input.plexPlaylistRatingKey},
      ${input.requestedItemCount},
      ${input.publishedItemCount},
      ${input.status},
      ${input.errorSummary ? input.errorSummary.slice(0, 1_000) : null}
    )
  `
}

export async function getPlaylistGeneration(
  database: Database,
  userId: string,
  generationId: string,
): Promise<PlaylistGenerationRecord | null> {
  const generationRows = await database<Array<PlaylistGenerationRow>>`
    SELECT g.id, g.name, g.seed_track_id, g.seed_label, g.status, g.algorithm_version,
           g.target_size, g.acquire_missing, g.publish_to_plex, g.error_summary,
           g.created_at, g.updated_at, g.published_at,
           playlist.plex_rating_key AS plex_playlist_rating_key
    FROM playlist_generations g
    LEFT JOIN playlists playlist ON playlist.id = g.plex_playlist_id
    WHERE g.id = ${generationId} AND g.user_id = ${userId}
    LIMIT 1
  `
  const row = generationRows[0]
  if (!row) {
    return null
  }

  const itemRows = await database<Array<PlaylistGenerationItemRow>>`
    SELECT id, position, track_id, track_title, artist_name, album_title, state, score, reason_codes,
           published_at
    FROM playlist_generation_items
    WHERE generation_id = ${generationId}
    ORDER BY position ASC
  `
  const items = itemRows.map(toGenerationItemRecord)
  const stateCounts = emptyStateCounts()
  for (const item of itemRows) {
    stateCounts[item.state] += 1
  }
  const publishedCount = itemRows.filter((item) => item.published_at !== null).length
  return { ...toGenerationSummary(row, stateCounts, publishedCount), items }
}

export async function listPlaylistGenerations(
  database: Database,
  userId: string,
  limit = 30,
): Promise<PlaylistGenerationSummaryRecord[]> {
  const rows = await database<
    Array<PlaylistGenerationRow & { item_counts: unknown; published_count: string | number | null }>
  >`
    SELECT g.id, g.name, g.seed_track_id, g.seed_label, g.status, g.algorithm_version,
           g.target_size, g.acquire_missing, g.publish_to_plex, g.error_summary,
           g.created_at, g.updated_at, g.published_at,
           playlist.plex_rating_key AS plex_playlist_rating_key,
           COALESCE(counts.item_counts, '{}'::jsonb) AS item_counts
    FROM playlist_generations g
    LEFT JOIN playlists playlist ON playlist.id = g.plex_playlist_id
    LEFT JOIN LATERAL (
      SELECT
        jsonb_object_agg(s.state, s.n) AS item_counts,
        COALESCE(SUM(s.published_n), 0) AS published_count
      FROM (
        SELECT state,
               COUNT(*) AS n,
               COUNT(*) FILTER (WHERE published_at IS NOT NULL) AS published_n
        FROM playlist_generation_items
        WHERE generation_id = g.id
        GROUP BY state
      ) s
    ) counts ON true
    WHERE g.user_id = ${userId}
    ORDER BY g.created_at DESC
    LIMIT ${Math.min(100, Math.max(1, limit))}
  `
  return rows.map((row) =>
    toGenerationSummary(row, parseStateCounts(row.item_counts), Number(row.published_count ?? 0)),
  )
}

type PlaylistGenerationRow = {
  id: string
  name: string
  seed_track_id: string | null
  seed_label: string
  status: PlaylistGenerationStatus
  algorithm_version: string
  target_size: number
  acquire_missing: boolean
  publish_to_plex: boolean
  error_summary: string | null
  created_at: Date | string
  updated_at: Date | string
  published_at: Date | string | null
  plex_playlist_rating_key: string | null
}

type PlaylistGenerationItemRow = {
  id: string
  position: number
  track_id: string | null
  track_title: string
  artist_name: string
  album_title: string | null
  state: PlaylistGenerationItemState
  score: string | number
  reason_codes: unknown
  published_at: Date | string | null
}

function toGenerationItemRecord(row: PlaylistGenerationItemRow): PlaylistGenerationItemRecord {
  return {
    id: row.id,
    position: row.position,
    trackId: row.track_id,
    trackTitle: row.track_title,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    state: row.state,
    inLibrary: row.state === 'in_library' || row.state === 'matched',
    score: clampScore(Number(row.score)),
    reasons: Array.isArray(row.reason_codes) ? (row.reason_codes as unknown[]) : [],
  }
}

function toGenerationSummary(
  row: PlaylistGenerationRow,
  stateCounts?: Record<PlaylistGenerationItemState, number>,
  publishedCount = 0,
): PlaylistGenerationSummaryRecord {
  const counts = stateCounts ?? emptyStateCounts()
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return {
    id: row.id,
    name: row.name,
    seedTrackId: row.seed_track_id,
    seedLabel: row.seed_label,
    status: row.status,
    algorithmVersion: row.algorithm_version,
    targetSize: row.target_size,
    acquireMissing: row.acquire_missing,
    publishToPlex: row.publish_to_plex,
    counts: {
      total,
      inLibrary: counts.in_library + counts.matched,
      awaitingAcquisition: counts.pending + counts.requested + counts.downloading + counts.imported,
      unavailable: counts.unavailable,
      published: publishedCount,
    },
    plexPlaylistRatingKey: row.plex_playlist_rating_key,
    errorSummary: row.error_summary,
    createdAt: serialiseTimestamp(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: serialiseTimestamp(row.updated_at) ?? new Date(0).toISOString(),
    publishedAt: serialiseTimestamp(row.published_at),
  }
}

function parseStateCounts(value: unknown): Record<PlaylistGenerationItemState, number> {
  const counts = emptyStateCounts()
  if (value && typeof value === 'object') {
    for (const [state, count] of Object.entries(value as Record<string, unknown>)) {
      if (state in counts) {
        counts[state as PlaylistGenerationItemState] = Number(count) || 0
      }
    }
  }
  return counts
}

function emptyStateCounts(): Record<PlaylistGenerationItemState, number> {
  return {
    in_library: 0,
    pending: 0,
    requested: 0,
    downloading: 0,
    imported: 0,
    matched: 0,
    unavailable: 0,
  }
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function serialiseTimestamp(value: Date | string | null): string | null {
  if (!value) {
    return null
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString()
}

export { IN_FLIGHT_STATES }

/** Close acquisition waits after 24 hours. A later Plex sync can still resolve
 * the track in a new generation; no Lidarr downloads are cancelled here. */
export async function expireStalledGenerationItems(database: Database, generationId: string): Promise<void> {
  await database`
    UPDATE playlist_generation_items
    SET state = 'unavailable', updated_at = NOW()
    WHERE generation_id = ${generationId}
      AND state IN ('requested', 'downloading', 'imported')
      AND COALESCE(acquisition_requested_at, created_at) < NOW() - INTERVAL '24 hours'
  `
}
