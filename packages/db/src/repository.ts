import postgres, { type TransactionSql } from 'postgres'
import { derivePlexListeningObservations } from './listening-observations.js'

export type Database = ReturnType<typeof createDatabase>

export type SetupStatusRecord = {
  configured: boolean
  plexServer: {
    name: string
    machineIdentifier: string
    lastSeenAt: string | null
  } | null
}

export type InitialSetup = {
  ownerUsername: string
  passwordHash: string
  machineIdentifier: string
  serverName: string
  baseUrl: string
  tokenCiphertext: string
  selectedLibraries: Array<{ plexSectionId: string; title: string }>
}

export type InitialSetupResult = {
  user: { id: string; username: string; role: 'owner' }
  server: { id: string; name: string; machineIdentifier: string }
}

export type LibrarySyncSource = {
  plexServerId: string
  machineIdentifier: string
  librarySectionId: string
  plexSectionId: string
  serverName: string
  baseUrl: string
  tokenCiphertext: string
  ownerUserId: string
  ownerTimezone: string
}

export type LibraryTrackUpsert = {
  plexRatingKey: string
  title: string
  trackNumber: number | null
  discNumber: number | null
  durationMs: number | null
  addedAt: string | null
  plexUpdatedAt: string | null
  playCount: number
  lastPlayedAt: string | null
  rating: number | null
  artist: { plexRatingKey: string; name: string; thumbKey: string | null }
  album: {
    plexRatingKey: string
    title: string
    year: number | null
    thumbKey: string | null
  }
  genres: string[]
}

export type SyncProgress = {
  offset: number
  importedTracks: number
  skippedTracks: number
}

export type SyncFailureClassification =
  | 'configuration'
  | 'authentication'
  | 'upstream_unavailable'
  | 'upstream_response'
  | 'unknown'

export type SyncRunRecord = {
  id: string
  librarySectionId: string | null
  libraryTitle: string | null
  kind: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  counts: { importedTracks: number; skippedTracks: number }
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  failure: { classification: SyncFailureClassification; summary: string } | null
}

export type PlexPlaylistUpsert = {
  plexRatingKey: string
  title: string
  revision: string | null
  items: Array<{
    plexTrackRatingKey: string
    addedAt: string | null
  }>
}

export type RecommendationKind = 'daily_mix' | 'forgotten_favourites' | 'hidden_gems' | 'recently_added'

export type RecommendationCandidateRecord = {
  trackId: string
  artistId: string
  artistName: string
  albumId: string
  albumTitle: string
  trackTitle: string
  genres: string[]
  addedAt: string | null
  lastPlayedAt: string | null
  rating: number | null
  playCount: number
  durationMs: number | null
  plexRatingKey: string
}

export type PersistedRecommendation = {
  trackId: string
  rank: number
  score: number
  reasons: object[]
  summary: string
}

export type LatestRecommendation = {
  runId: string
  kind: RecommendationKind
  algorithmVersion: string
  createdAt: string
  trackId: string
  trackTitle: string
  artistName: string
  albumTitle: string
  rank: number
  score: number
  reasons: object[]
  summary: string
}

export type DashboardFavourite = {
  id: string
  name: string
  playCount: number
}

export type DashboardOverview = {
  library: {
    artistCount: number
    albumCount: number
    trackCount: number
    totalDurationMs: number
    newestAddedAt: string | null
  }
  listening: {
    totalPlayCount: number
    playedTrackCount: number
    ratedTrackCount: number
    lastPlayedAt: string | null
  }
  favourites: {
    artists: DashboardFavourite[]
    genres: DashboardFavourite[]
  }
  sync: {
    status: 'not_started' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    lastCompletedAt: string | null
    errorSummary: string | null
  }
  dailyMix: LatestRecommendation[]
}

export type ScrobbleImportItem = {
  artistName: string
  trackTitle: string
  albumTitle?: string
  occurredAt: string
}

export type ScrobbleImportResult = {
  importedCount: number
  matchedTracksCount: number
  unmatchedCount: number
}

export type PlaylistProposalItemRecord = {
  trackId: string
  trackTitle: string
  artistName: string
  albumTitle: string
  durationMs: number | null
  plexRatingKey: string
  position: number
}

export type PlaylistProposalRecord = {
  id: string
  title: string
  kind: string
  algorithmVersion: string
  status: 'draft' | 'exported' | 'dismissed'
  plexPlaylistRatingKey: string | null
  createdAt: string
  items: PlaylistProposalItemRecord[]
}

export async function createPlaylistProposal(
  database: Database,
  input: {
    userId: string
    title: string
    kind: string
    algorithmVersion: string
    trackIds: string[]
  },
): Promise<PlaylistProposalRecord> {
  return database.begin(async (transaction) => {
    const rows = await transaction<Array<{ id: string; created_at: Date | string }>>`
      INSERT INTO playlist_proposals (user_id, title, kind, algorithm_version, status)
      VALUES (${input.userId}, ${input.title}, ${input.kind}, ${input.algorithmVersion}, 'draft')
      RETURNING id, created_at
    `
    const proposal = rows[0]
    if (!proposal) {
      throw new Error('Failed to create playlist proposal.')
    }

    for (const [position, trackId] of input.trackIds.entries()) {
      await transaction`
        INSERT INTO playlist_proposal_items (proposal_id, position, track_id)
        VALUES (${proposal.id}, ${position}, ${trackId})
      `
    }

    const createdRecord = await getPlaylistProposal(transaction as unknown as Database, proposal.id, input.userId)
    if (!createdRecord) {
      throw new Error('Failed to retrieve created playlist proposal.')
    }
    return createdRecord
  })
}

export async function getPlaylistProposal(
  database: Database,
  proposalId: string,
  userId: string,
): Promise<PlaylistProposalRecord | null> {
  const rows = await database<
    Array<{
      id: string
      title: string
      kind: string
      algorithm_version: string
      status: 'draft' | 'exported' | 'dismissed'
      plex_playlist_rating_key: string | null
      created_at: Date | string
    }>
  >`
    SELECT id, title, kind, algorithm_version, status, plex_playlist_rating_key, created_at
    FROM playlist_proposals
    WHERE id = ${proposalId}::uuid AND user_id = ${userId}::uuid
    LIMIT 1
  `
  const proposal = rows[0]
  if (!proposal) {
    return null
  }

  const itemRows = await database<
    Array<{
      track_id: string
      track_title: string
      artist_name: string
      album_title: string
      duration_ms: number | null
      plex_rating_key: string
      position: number
    }>
  >`
    SELECT
      ppi.track_id,
      t.title AS track_title,
      artist.name AS artist_name,
      album.title AS album_title,
      t.duration_ms,
      t.plex_rating_key,
      ppi.position
    FROM playlist_proposal_items ppi
    JOIN tracks t ON t.id = ppi.track_id
    JOIN albums album ON album.id = t.album_id
    JOIN artists artist ON artist.id = album.artist_id
    WHERE ppi.proposal_id = ${proposal.id}::uuid
    ORDER BY ppi.position ASC
  `

  return {
    id: proposal.id,
    title: proposal.title,
    kind: proposal.kind,
    algorithmVersion: proposal.algorithm_version,
    status: proposal.status,
    plexPlaylistRatingKey: proposal.plex_playlist_rating_key,
    createdAt: serialiseTimestamp(proposal.created_at) ?? new Date().toISOString(),
    items: itemRows.map((item) => ({
      trackId: item.track_id,
      trackTitle: item.track_title,
      artistName: item.artist_name,
      albumTitle: item.album_title,
      durationMs: item.duration_ms,
      plexRatingKey: item.plex_rating_key,
      position: item.position,
    })),
  }
}

export async function listPlaylistProposals(
  database: Database,
  userId: string,
): Promise<PlaylistProposalRecord[]> {
  const rows = await database<Array<{ id: string }>>`
    SELECT id
    FROM playlist_proposals
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC
  `
  const proposals: PlaylistProposalRecord[] = []
  for (const row of rows) {
    const proposal = await getPlaylistProposal(database, row.id, userId)
    if (proposal) {
      proposals.push(proposal)
    }
  }
  return proposals
}

export async function markPlaylistProposalExported(
  database: Database,
  proposalId: string,
  userId: string,
  plexPlaylistRatingKey: string,
): Promise<void> {
  await database`
    UPDATE playlist_proposals
    SET status = 'exported',
        plex_playlist_rating_key = ${plexPlaylistRatingKey},
        updated_at = NOW()
    WHERE id = ${proposalId}::uuid AND user_id = ${userId}::uuid
      AND status = 'draft'
  `
}

export async function importScrobbles(
  database: Database,
  userId: string,
  scrobbles: ScrobbleImportItem[],
): Promise<ScrobbleImportResult> {
  if (scrobbles.length === 0) {
    return { importedCount: 0, matchedTracksCount: 0, unmatchedCount: 0 }
  }

  // Find user's Plex server ID
  const servers = await database<Array<{ id: string }>>`
    SELECT ps.id
    FROM plex_servers ps
    LIMIT 1
  `
  const plexServerId = servers[0]?.id
  if (!plexServerId) {
    throw new Error('NO_PLEX_SERVER_CONFIGURED')
  }

  // Get user timezone for rollup rebuild if needed
  const timezone = await getUserTimezone(database, userId)

  // Filter exact normalized pairs before materializing any catalog rows.
  // EXISTS avoids duplicating candidate tracks for repeated imported plays.
  const pairs = new Map<string, { artist: string; title: string }>()
  for (const scrobble of scrobbles) {
    const artist = scrobble.artistName.trim().toLowerCase()
    const title = scrobble.trackTitle.trim().toLowerCase()
    pairs.set(JSON.stringify([artist, title]), { artist, title })
  }
  const requestedPairs = JSON.stringify(Array.from(pairs.values()))

  // Fetch only mirrored tracks that could match this import
  const catalog = await database<
    Array<{
      track_id: string
      artist_name: string
      track_title: string
      album_title: string
      duration_ms: number | null
    }>
  >`
    SELECT
      t.id AS track_id,
      LOWER(artist.name) AS artist_name,
      LOWER(t.title) AS track_title,
      LOWER(album.title) AS album_title,
      t.duration_ms
    FROM tracks t
    JOIN albums album ON album.id = t.album_id
    JOIN artists artist ON artist.id = album.artist_id
    WHERE artist.plex_server_id = ${plexServerId}::uuid
      AND EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${requestedPairs}::jsonb) AS wanted(artist text, title text)
        WHERE wanted.artist = LOWER(artist.name) AND wanted.title = LOWER(t.title)
      )
  `

  type CatalogTrack = (typeof catalog)[number]
  const catalogMap = new Map<string, CatalogTrack[]>()

  for (const item of catalog) {
    const key = `${item.artist_name}|||${item.track_title}`
    const existing = catalogMap.get(key) ?? []
    existing.push(item)
    catalogMap.set(key, existing)
  }

  let importedCount = 0
  let matchedTracksCount = 0
  let unmatchedCount = 0
  const matchedTrackIds = new Set<string>()

  await database.begin(async (transaction) => {
    for (const scrobble of scrobbles) {
      const artistNorm = scrobble.artistName.trim().toLowerCase()
      const trackNorm = scrobble.trackTitle.trim().toLowerCase()
      const albumNorm = scrobble.albumTitle ? scrobble.albumTitle.trim().toLowerCase() : null

      const candidates = catalogMap.get(`${artistNorm}|||${trackNorm}`)
      if (!candidates || candidates.length === 0) {
        unmatchedCount++
        continue
      }

      let matched = candidates[0]!
      if (albumNorm && candidates.length > 1) {
        const exactAlbum = candidates.find((c) => c.album_title === albumNorm)
        if (exactAlbum) {
          matched = exactAlbum
        }
      }

      matchedTrackIds.add(matched.track_id)
      const occurredAt = new Date(scrobble.occurredAt)
      const sourceEventId = `scrobble:${userId}:${matched.track_id}:${occurredAt.getTime()}`

      const inserted = await transaction`
        INSERT INTO listening_events (
          user_id, track_id, plex_server_id, source_event_id, event_type, occurred_at,
          play_count_delta, rating_before, rating_after, duration_ms, time_precision, metadata
        ) VALUES (
          ${userId},
          ${matched.track_id},
          ${plexServerId},
          ${sourceEventId},
          'play_count_delta',
          ${occurredAt.toISOString()},
          1,
          NULL,
          NULL,
          ${matched.duration_ms},
          'exact',
          ${JSON.stringify({ source: 'scrobble_import' })}::jsonb
        ) ON CONFLICT (source_event_id) DO NOTHING
        RETURNING id
      `

      if (inserted.length > 0) {
        importedCount++
        // Update user_item_state play count and last_played_at
        await transaction`
          INSERT INTO user_item_state (user_id, entity_type, entity_id, rating, play_count, last_played_at)
          VALUES (
            ${userId},
            'track',
            ${matched.track_id},
            NULL,
            1,
            ${occurredAt.toISOString()}
          )
          ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE
          SET play_count = user_item_state.play_count + 1,
              last_played_at = GREATEST(COALESCE(user_item_state.last_played_at, '1970-01-01'::timestamptz), EXCLUDED.last_played_at),
              updated_at = NOW()
        `
      }
    }
  })

  matchedTracksCount = matchedTrackIds.size

  if (importedCount > 0) {
    await rebuildListeningRollups(database, userId, timezone)
  }

  return {
    importedCount,
    matchedTracksCount,
    unmatchedCount,
  }
}

export type ListeningCoverage = 'none' | 'exact' | 'observed' | 'mixed'

export type ListeningInsightSummary = {
  period: {
    startDate: string
    endDate: string
    timezone: string
  }
  playback: {
    reportedPlays: number
    exactPlays: number
    observedPlays: number
    estimatedListenedMs: number
    uniqueTracks: number
    uniqueArtists: number
    coverage: ListeningCoverage
  }
  topArtists: DashboardFavourite[]
}

export type DailyBriefCard = {
  kind: 'daily_mix' | 'favourite_artist' | 'favourite_genre' | 'library' | 'sync'
  title: string
  body: string
}

export type DailyBriefContent = {
  headline: string
  summary: string
  cards: DailyBriefCard[]
}

export type DailyBriefDeliveryStatus = 'pending' | 'delivered' | 'failed'

export type DailyBriefDelivery = {
  status: DailyBriefDeliveryStatus
  attemptCount: number
  lastAttemptAt: string | null
  deliveredAt: string | null
  errorSummary: string | null
}

export type DailyBriefRecord = {
  id: string
  briefDate: string
  timezone: string
  algorithmVersion: string
  content: DailyBriefContent
  createdAt: string
  discordDelivery: DailyBriefDelivery | null
}

export function createDatabase(databaseUrl: string) {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 8,
    onnotice: () => undefined,
  })
}

export async function getDatabaseStatus(database: Database): Promise<'connected' | 'unavailable'> {
  try {
    await database`SELECT 1`
    return 'connected'
  } catch {
    return 'unavailable'
  }
}

export async function getSetupStatus(database: Database): Promise<SetupStatusRecord> {
  const servers = await database<
    Array<{
      name: string
      machine_identifier: string
      last_seen_at: string | null
    }>
  >`SELECT name, machine_identifier, last_seen_at FROM plex_servers ORDER BY created_at ASC LIMIT 1`

  const server = servers[0]
  if (!server) {
    return { configured: false, plexServer: null }
  }

  return {
    configured: true,
    plexServer: {
      name: server.name,
      machineIdentifier: server.machine_identifier,
      lastSeenAt: server.last_seen_at,
    },
  }
}

export async function insertInitialSetup(database: Database, setup: InitialSetup): Promise<InitialSetupResult> {
  return database.begin(async (transaction) => {
    const existing = await transaction`SELECT id FROM instances LIMIT 1`
    if (existing.length > 0) {
      throw new Error('INSTANCE_ALREADY_CONFIGURED')
    }

    await transaction`INSERT INTO instances DEFAULT VALUES`
    const users = await transaction<Array<{ id: string; username: string; role: 'owner' }>>`
      INSERT INTO users (username, password_hash, role)
      VALUES (${setup.ownerUsername}, ${setup.passwordHash}, 'owner')
      RETURNING id, username, role
    `
    const user = users[0]
    if (!user) {
      throw new Error('Failed to create the local owner account.')
    }

    const servers = await transaction<Array<{ id: string; name: string; machine_identifier: string }>>`
      INSERT INTO plex_servers (
        machine_identifier,
        name,
        base_url,
        token_ciphertext,
        status,
        last_seen_at
      ) VALUES (
        ${setup.machineIdentifier},
        ${setup.serverName},
        ${setup.baseUrl},
        ${setup.tokenCiphertext},
        'connected',
        NOW()
      )
      RETURNING id, name, machine_identifier
    `
    const server = servers[0]
    if (!server) {
      throw new Error('Failed to save the Plex server.')
    }

    for (const library of setup.selectedLibraries) {
      await transaction`
        INSERT INTO library_sections (plex_server_id, plex_section_id, title, type, selected)
        VALUES (${server.id}, ${library.plexSectionId}, ${library.title}, 'artist', true)
      `
    }

    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata)
      VALUES ('system', ${user.id}, 'setup.completed', 'plex_server', ${server.id}, ${JSON.stringify({
        selectedLibraryCount: setup.selectedLibraries.length,
      })}::jsonb)
    `

    return {
      user,
      server: {
        id: server.id,
        name: server.name,
        machineIdentifier: server.machine_identifier,
      },
    }
  })
}

export async function getLibrarySyncSources(
  database: Database,
  librarySectionId?: string,
): Promise<LibrarySyncSource[]> {
  const sources = await database<
    Array<{
      plex_server_id: string
      machine_identifier: string
      library_section_id: string
      plex_section_id: string
      server_name: string
      base_url: string
      token_ciphertext: string
      owner_user_id: string
      owner_timezone: string
    }>
  >`
    SELECT
      ps.id AS plex_server_id,
      ps.machine_identifier,
      ls.id AS library_section_id,
      ls.plex_section_id,
      ps.name AS server_name,
      ps.base_url,
      ps.token_ciphertext,
      owner_user.id AS owner_user_id,
      owner_user.timezone AS owner_timezone
    FROM library_sections ls
    JOIN plex_servers ps ON ps.id = ls.plex_server_id
    CROSS JOIN LATERAL (
      SELECT id, timezone FROM users WHERE role = 'owner' AND disabled_at IS NULL ORDER BY created_at ASC LIMIT 1
    ) owner_user
    WHERE ls.selected = true
    AND (${librarySectionId ?? null}::uuid IS NULL OR ls.id = ${librarySectionId ?? null}::uuid)
    ORDER BY ls.created_at ASC
  `

  return sources.map((source) => ({
    plexServerId: source.plex_server_id,
    machineIdentifier: source.machine_identifier,
    librarySectionId: source.library_section_id,
    plexSectionId: source.plex_section_id,
    serverName: source.server_name,
    baseUrl: source.base_url,
    tokenCiphertext: source.token_ciphertext,
    ownerUserId: source.owner_user_id,
    ownerTimezone: source.owner_timezone,
  }))
}

/** A run still marked running after this long was orphaned by a crash, OOM kill or redeploy. */
export const STALE_SYNC_RUN_HOURS = 6

/** Classified as retryable so getResumableSyncProgress can continue from the saved cursor. */
export const INTERRUPTED_SYNC_SUMMARY = 'upstream_unavailable: The sync was interrupted before it finished.'

/**
 * Marks orphaned running rows as failed. Nothing else ever moves a row whose worker died, so
 * the dashboard would show "Syncing" forever and the resume path (failed rows only) never saw it.
 * A live worker that finishes later still overwrites this with 'completed' in completeSyncRun.
 */
export async function reapStaleSyncRuns(database: Database): Promise<void> {
  await database`
    UPDATE sync_runs
    SET status = 'failed', finished_at = NOW(), error_summary = ${INTERRUPTED_SYNC_SUMMARY}
    WHERE status = 'running'
      AND COALESCE(started_at, created_at) < NOW() - make_interval(hours => ${STALE_SYNC_RUN_HOURS})
  `
}

export async function listSyncRuns(database: Database, limit = 50): Promise<SyncRunRecord[]> {
  await reapStaleSyncRuns(database)
  const rows = await database<SyncRunRow[]>`
    SELECT sr.id, sr.library_section_id, ls.title AS library_title, sr.kind, sr.status,
           sr.counts, sr.error_summary, sr.started_at, sr.finished_at, sr.created_at
    FROM sync_runs sr
    LEFT JOIN library_sections ls ON ls.id = sr.library_section_id
    ORDER BY sr.created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `
  return rows.map(toSyncRunRecord)
}

export async function getSyncRun(database: Database, runId: string): Promise<SyncRunRecord | null> {
  const rows = await database<SyncRunRow[]>`
    SELECT sr.id, sr.library_section_id, ls.title AS library_title, sr.kind, sr.status,
           sr.counts, sr.error_summary, sr.started_at, sr.finished_at, sr.created_at
    FROM sync_runs sr
    LEFT JOIN library_sections ls ON ls.id = sr.library_section_id
    WHERE sr.id = ${runId}::uuid
    LIMIT 1
  `
  return rows[0] ? toSyncRunRecord(rows[0]) : null
}

/** Failures worth resuming from: the Plex data read so far is still valid. */
const RESUMABLE_SYNC_FAILURES = ['upstream_unavailable', 'upstream_response', 'unknown'] as const

/** A failed run older than this is not resumed; the library may have changed underneath it. */
const RESUMABLE_SYNC_MAX_AGE_HOURS = 24

/**
 * Returns the saved progress of the latest run for a library section when that run failed
 * with a retryable classification recently enough to continue from. Otherwise returns null
 * and the next run starts from the beginning.
 */
export async function getResumableSyncProgress(
  database: Database,
  librarySectionId: string,
): Promise<SyncProgress | null> {
  await reapStaleSyncRuns(database)
  const rows = await database<Array<{ status: string; error_summary: string | null; cursor: unknown; counts: unknown; recent: boolean }>>`
    SELECT status, error_summary, cursor, counts,
           COALESCE(finished_at, created_at) > NOW() - make_interval(hours => ${RESUMABLE_SYNC_MAX_AGE_HOURS}) AS recent
    FROM sync_runs
    WHERE library_section_id = ${librarySectionId}
    ORDER BY created_at DESC
    LIMIT 1
  `
  return resumableProgressFromRun(rows[0])
}

export function resumableProgressFromRun(
  run: { status: string; error_summary: string | null; cursor: unknown; counts: unknown; recent: boolean } | undefined,
): SyncProgress | null {
  if (!run || run.status !== 'failed' || !run.recent) return null
  const classification = run.error_summary?.split(':', 1)[0] ?? ''
  if (!(RESUMABLE_SYNC_FAILURES as readonly string[]).includes(classification)) return null
  const cursor = typeof run.cursor === 'object' && run.cursor !== null ? (run.cursor as Record<string, unknown>) : {}
  const offset = nonNegativeInteger(cursor.offset)
  if (offset === 0) return null
  return { offset, ...parseSyncCounts(run.counts) }
}

export async function beginSyncRun(
  database: Database,
  source: LibrarySyncSource,
  trigger: 'initial-setup' | 'manual' | 'webhook' | 'reconciliation',
  start: SyncProgress = { offset: 0, importedTracks: 0, skippedTracks: 0 },
): Promise<string> {
  const result = await database<Array<{ id: string }>>`
    INSERT INTO sync_runs (plex_server_id, library_section_id, kind, status, started_at, cursor, counts)
    VALUES (
      ${source.plexServerId},
      ${source.librarySectionId},
      ${`${trigger}-library-import`},
      'running',
      NOW(),
      ${JSON.stringify({ offset: start.offset })}::jsonb,
      ${JSON.stringify({ importedTracks: start.importedTracks, skippedTracks: start.skippedTracks })}::jsonb
    )
    RETURNING id
  `
  const run = result[0]
  if (!run) {
    throw new Error('Failed to create a library sync run.')
  }
  return run.id
}

export async function updateSyncProgress(database: Database, runId: string, progress: SyncProgress): Promise<void> {
  await database`
    UPDATE sync_runs
    SET cursor = ${JSON.stringify({ offset: progress.offset })}::jsonb,
        counts = ${JSON.stringify({
          importedTracks: progress.importedTracks,
          skippedTracks: progress.skippedTracks,
        })}::jsonb
    WHERE id = ${runId}
  `
}

export async function completeSyncRun(
  database: Database,
  runId: string,
  librarySectionId: string,
  progress: SyncProgress,
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE sync_runs
      SET status = 'completed',
          finished_at = NOW(),
          cursor = ${JSON.stringify({ offset: progress.offset })}::jsonb,
          counts = ${JSON.stringify({
            importedTracks: progress.importedTracks,
            skippedTracks: progress.skippedTracks,
          })}::jsonb
      WHERE id = ${runId}
    `
    await transaction`
      UPDATE library_sections
      SET last_full_sync_at = NOW(), updated_at = NOW()
      WHERE id = ${librarySectionId}
    `
  })
}

export async function failSyncRun(database: Database, runId: string, error: unknown): Promise<void> {
  await database`
    UPDATE sync_runs
    SET status = 'failed', finished_at = NOW(), error_summary = ${sanitiseSyncFailure(error)}
    WHERE id = ${runId}
  `
}

export async function rebuildListeningRollups(database: Database, userId: string, timezone: string): Promise<void> {
  await database.begin(async (transaction) => {
    // Multiple Plex libraries can sync concurrently. Serialize a user's derived views so that a
    // complete rebuild is always applied atomically rather than interleaving delete/insert passes.
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`

    await transaction`DELETE FROM user_track_rollups WHERE user_id = ${userId}`
    await transaction`DELETE FROM user_artist_rollups WHERE user_id = ${userId}`

    await transaction`
      INSERT INTO user_track_rollups (
        user_id, track_id, period_start, period_kind, reported_plays, exact_plays,
        observed_plays, estimated_listened_ms, last_event_at
      )
      SELECT
        event.user_id,
        event.track_id,
        (event.occurred_at AT TIME ZONE ${timezone})::date,
        'day',
        COALESCE(SUM(event.play_count_delta), 0)::integer,
        COALESCE(SUM(event.play_count_delta) FILTER (WHERE event.time_precision = 'exact'), 0)::integer,
        COALESCE(SUM(event.play_count_delta) FILTER (WHERE event.time_precision = 'observed'), 0)::integer,
        COALESCE(SUM(COALESCE(event.duration_ms, 0)::bigint * event.play_count_delta), 0)::bigint,
        MAX(event.occurred_at)
      FROM listening_events event
      WHERE event.user_id = ${userId}
        AND event.event_type = 'play_count_delta'
      GROUP BY event.user_id, event.track_id, (event.occurred_at AT TIME ZONE ${timezone})::date
    `

    await transaction`
      INSERT INTO user_artist_rollups (
        user_id, artist_id, period_start, period_kind, reported_plays, exact_plays,
        observed_plays, estimated_listened_ms, unique_tracks, last_event_at
      )
      SELECT
        event.user_id,
        artist.id,
        (event.occurred_at AT TIME ZONE ${timezone})::date,
        'day',
        COALESCE(SUM(event.play_count_delta), 0)::integer,
        COALESCE(SUM(event.play_count_delta) FILTER (WHERE event.time_precision = 'exact'), 0)::integer,
        COALESCE(SUM(event.play_count_delta) FILTER (WHERE event.time_precision = 'observed'), 0)::integer,
        COALESCE(SUM(COALESCE(event.duration_ms, 0)::bigint * event.play_count_delta), 0)::bigint,
        COUNT(DISTINCT event.track_id)::integer,
        MAX(event.occurred_at)
      FROM listening_events event
      JOIN tracks track ON track.id = event.track_id
      JOIN albums album ON album.id = track.album_id
      JOIN artists artist ON artist.id = album.artist_id
      WHERE event.user_id = ${userId}
        AND event.event_type = 'play_count_delta'
      GROUP BY event.user_id, artist.id, (event.occurred_at AT TIME ZONE ${timezone})::date
    `
  })
}

async function recordPlexListeningChanges(
  transaction: TransactionSql,
  input: {
    source: LibrarySyncSource
    trackId: string
    track: LibraryTrackUpsert
    previousState:
      | {
          play_count: number
          last_played_at: Date | string | null
          rating: number | string | null
        }
      | undefined
  },
): Promise<void> {
  const observations = derivePlexListeningObservations({
    source: input.source,
    trackId: input.trackId,
    track: input.track,
    previousState: input.previousState
      ? {
          playCount: input.previousState.play_count,
          lastPlayedAt: input.previousState.last_played_at,
          rating: input.previousState.rating,
        }
      : undefined,
    observedAt: new Date(),
  })

  for (const observation of observations) {
    await transaction`
      INSERT INTO listening_events (
        user_id, track_id, plex_server_id, source_event_id, event_type, occurred_at,
        play_count_delta, rating_before, rating_after, duration_ms, time_precision, metadata
      ) VALUES (
        ${input.source.ownerUserId},
        ${input.trackId},
        ${input.source.plexServerId},
        ${observation.sourceEventId},
        ${observation.eventType},
        ${observation.occurredAt},
        ${observation.playCountDelta},
        ${observation.ratingBefore},
        ${observation.ratingAfter},
        ${observation.durationMs},
        ${observation.timePrecision},
        ${JSON.stringify(observation.metadata)}::jsonb
      ) ON CONFLICT (source_event_id) DO NOTHING
    `
  }
}

export async function upsertLibraryTracks(
  database: Database,
  source: LibrarySyncSource,
  tracks: LibraryTrackUpsert[],
): Promise<void> {
  if (tracks.length === 0) {
    return
  }

  await database.begin(async (transaction) => {
    for (const track of tracks) {
      const artists = await transaction<Array<{ id: string }>>`
        INSERT INTO artists (plex_server_id, plex_rating_key, name, thumb_key, plex_updated_at)
        VALUES (
          ${source.plexServerId},
          ${track.artist.plexRatingKey},
          ${track.artist.name},
          ${track.artist.thumbKey},
          ${track.plexUpdatedAt}
        )
        ON CONFLICT (plex_server_id, plex_rating_key) DO UPDATE
        SET name = EXCLUDED.name,
            thumb_key = COALESCE(EXCLUDED.thumb_key, artists.thumb_key),
            plex_updated_at = GREATEST(artists.plex_updated_at, EXCLUDED.plex_updated_at),
            updated_at = NOW()
        RETURNING id
      `
      const artist = artists[0]
      if (!artist) {
        throw new Error('Failed to upsert a Plex artist.')
      }

      const albums = await transaction<Array<{ id: string }>>`
        INSERT INTO albums (artist_id, plex_rating_key, title, year, thumb_key, plex_updated_at)
        VALUES (
          ${artist.id},
          ${track.album.plexRatingKey},
          ${track.album.title},
          ${track.album.year},
          ${track.album.thumbKey},
          ${track.plexUpdatedAt}
        )
        ON CONFLICT (artist_id, plex_rating_key) DO UPDATE
        SET title = EXCLUDED.title,
            year = COALESCE(EXCLUDED.year, albums.year),
            thumb_key = COALESCE(EXCLUDED.thumb_key, albums.thumb_key),
            plex_updated_at = GREATEST(albums.plex_updated_at, EXCLUDED.plex_updated_at),
            updated_at = NOW()
        RETURNING id
      `
      const album = albums[0]
      if (!album) {
        throw new Error('Failed to upsert a Plex album.')
      }

      const savedTracks = await transaction<Array<{ id: string }>>`
        INSERT INTO tracks (
          album_id, plex_rating_key, title, track_number, disc_number, duration_ms, added_at, plex_updated_at
        ) VALUES (
          ${album.id},
          ${track.plexRatingKey},
          ${track.title},
          ${track.trackNumber},
          ${track.discNumber},
          ${track.durationMs},
          ${track.addedAt},
          ${track.plexUpdatedAt}
        )
        ON CONFLICT (album_id, plex_rating_key) DO UPDATE
        SET title = EXCLUDED.title,
            track_number = EXCLUDED.track_number,
            disc_number = EXCLUDED.disc_number,
            duration_ms = EXCLUDED.duration_ms,
            added_at = COALESCE(EXCLUDED.added_at, tracks.added_at),
            plex_updated_at = GREATEST(tracks.plex_updated_at, EXCLUDED.plex_updated_at),
            updated_at = NOW()
        RETURNING id
      `
      const savedTrack = savedTracks[0]
      if (!savedTrack) {
        throw new Error('Failed to upsert a Plex track.')
      }

      const previousStates = await transaction<
        Array<{
          play_count: number
          last_played_at: Date | string | null
          rating: number | string | null
        }>
      >`
        SELECT play_count, last_played_at, rating
        FROM user_item_state
        WHERE user_id = ${source.ownerUserId}
        AND entity_type = 'track'
        AND entity_id = ${savedTrack.id}
        FOR UPDATE
      `
      const previousState = previousStates[0]

      await transaction`
        INSERT INTO user_item_state (user_id, entity_type, entity_id, rating, play_count, last_played_at)
        VALUES (
          ${source.ownerUserId},
          'track',
          ${savedTrack.id},
          ${track.rating},
          ${track.playCount},
          ${track.lastPlayedAt}
        )
        ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE
        SET rating = EXCLUDED.rating,
            play_count = EXCLUDED.play_count,
            last_played_at = EXCLUDED.last_played_at,
            first_played_at = CASE
              WHEN user_item_state.first_played_at IS NULL
                AND EXCLUDED.play_count > user_item_state.play_count
                AND EXCLUDED.last_played_at IS NOT NULL
              THEN EXCLUDED.last_played_at
              ELSE user_item_state.first_played_at
            END,
            updated_at = NOW()
      `

      await recordPlexListeningChanges(transaction, {
        source,
        trackId: savedTrack.id,
        track,
        previousState,
      })

      await transaction`
        UPDATE playlist_items item
        SET track_id = ${savedTrack.id}
        FROM playlists playlist
        WHERE playlist.id = item.playlist_id
        AND playlist.plex_server_id = ${source.plexServerId}
        AND item.plex_track_rating_key = ${track.plexRatingKey}
        AND item.track_id IS NULL
      `

      await transaction`
        DELETE FROM item_genres
        WHERE entity_type = 'track' AND entity_id = ${savedTrack.id} AND source = 'plex'
      `
      for (const genre of track.genres) {
        const normalisedName = normaliseGenre(genre)
        if (!normalisedName) {
          continue
        }
        const genres = await transaction<Array<{ id: string }>>`
          INSERT INTO genres (normalised_name, display_name)
          VALUES (${normalisedName}, ${genre.trim()})
          ON CONFLICT (normalised_name) DO UPDATE SET display_name = EXCLUDED.display_name
          RETURNING id
        `
        const savedGenre = genres[0]
        if (!savedGenre) {
          throw new Error('Failed to upsert a Plex genre.')
        }
        await transaction`
          INSERT INTO item_genres (genre_id, entity_type, entity_id, source)
          VALUES (${savedGenre.id}, 'track', ${savedTrack.id}, 'plex')
          ON CONFLICT DO NOTHING
        `
      }
    }
  })
}

export async function upsertUserPlaylists(
  database: Database,
  source: LibrarySyncSource,
  playlists: PlexPlaylistUpsert[],
): Promise<{ importedPlaylists: number; unresolvedItems: number }> {
  let unresolvedItems = 0

  await database.begin(async (transaction) => {
    const trackRatingKeys = [
      ...new Set(playlists.flatMap((playlist) => playlist.items.map((item) => item.plexTrackRatingKey))),
    ]
    const resolvedTracks =
      trackRatingKeys.length === 0
        ? []
        : await transaction<Array<{ id: string; plexRatingKey: string }>>`
            SELECT track.id, track.plex_rating_key AS "plexRatingKey"
            FROM tracks track
            JOIN albums album ON album.id = track.album_id
            JOIN artists artist ON artist.id = album.artist_id
            WHERE artist.plex_server_id = ${source.plexServerId}
            AND track.plex_rating_key = ANY(${trackRatingKeys}::text[])
          `
    const trackIdsByPlexRatingKey = new Map(resolvedTracks.map((track) => [track.plexRatingKey, track.id]))

    for (const playlist of playlists) {
      const savedPlaylists = await transaction<Array<{ id: string }>>`
        INSERT INTO playlists (
          plex_server_id, plex_rating_key, name, kind, managed_by_musearr, revision, last_synced_at
        ) VALUES (
          ${source.plexServerId},
          ${playlist.plexRatingKey},
          ${playlist.title},
          'user',
          false,
          ${playlist.revision},
          NOW()
        )
        ON CONFLICT (plex_server_id, plex_rating_key) DO UPDATE
        SET name = EXCLUDED.name,
            -- Plex also lists playlists Musearr published; keep those marked as Musearr's.
            kind = CASE WHEN playlists.managed_by_musearr THEN playlists.kind ELSE 'user' END,
            revision = EXCLUDED.revision,
            last_synced_at = NOW(),
            updated_at = NOW()
        RETURNING id
      `
      const savedPlaylist = savedPlaylists[0]
      if (!savedPlaylist) {
        throw new Error('Failed to upsert a Plex playlist.')
      }

      await transaction`DELETE FROM playlist_items WHERE playlist_id = ${savedPlaylist.id}`
      const itemRows = playlist.items.map((item, position) => {
        const trackId = trackIdsByPlexRatingKey.get(item.plexTrackRatingKey) ?? null
        unresolvedItems += trackId ? 0 : 1
        return {
          playlist_id: savedPlaylist.id,
          position,
          plex_track_rating_key: item.plexTrackRatingKey,
          track_id: trackId,
          added_at: item.addedAt,
        }
      })
      for (let start = 0; start < itemRows.length; start += 1_000) {
        const batch = itemRows.slice(start, start + 1_000)
        await transaction`
          INSERT INTO playlist_items ${transaction(
            batch,
            'playlist_id',
            'position',
            'plex_track_rating_key',
            'track_id',
            'added_at',
          )}
        `
      }
    }

    const playlistKeys = playlists.map((playlist) => playlist.plexRatingKey)
    if (playlistKeys.length === 0) {
      await transaction`
        DELETE FROM playlists
        WHERE plex_server_id = ${source.plexServerId}
        AND kind = 'user'
        AND managed_by_musearr = false
      `
    } else {
      await transaction`
        DELETE FROM playlists
        WHERE plex_server_id = ${source.plexServerId}
        AND kind = 'user'
        AND managed_by_musearr = false
        AND NOT (plex_rating_key = ANY(${playlistKeys}::text[]))
      `
    }
  })

  return { importedPlaylists: playlists.length, unresolvedItems }
}

export async function getRecommendationCandidates(
  database: Database,
  userId: string,
): Promise<RecommendationCandidateRecord[]> {
  const rows = await database<
    Array<{
      track_id: string
      artist_id: string
      artist_name: string
      album_id: string
      album_title: string
      track_title: string
      genres: string[] | null
      added_at: Date | string | null
      last_played_at: Date | string | null
      rating: string | number | null
      play_count: number | null
      duration_ms: number | null
      plex_rating_key: string
    }>
  >`
    SELECT
      t.id AS track_id,
      artist.id AS artist_id,
      artist.name AS artist_name,
      album.id AS album_id,
      album.title AS album_title,
      t.title AS track_title,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT genre.display_name), NULL) AS genres,
      t.added_at,
      state.last_played_at,
      state.rating,
      state.play_count,
      t.duration_ms,
      t.plex_rating_key
    FROM tracks t
    JOIN albums album ON album.id = t.album_id
    JOIN artists artist ON artist.id = album.artist_id
    LEFT JOIN user_item_state state
      ON state.entity_type = 'track' AND state.entity_id = t.id AND state.user_id = ${userId}
    LEFT JOIN item_genres item_genre
      ON item_genre.entity_type = 'track' AND item_genre.entity_id = t.id
    LEFT JOIN genres genre ON genre.id = item_genre.genre_id
    GROUP BY
      t.id, artist.id, artist.name, album.id, album.title, t.title,
      t.added_at, state.last_played_at, state.rating, state.play_count,
      t.duration_ms, t.plex_rating_key
    ORDER BY artist.name ASC, album.title ASC, t.id ASC
  `

  return rows.map((row) => ({
    trackId: row.track_id,
    artistId: row.artist_id,
    artistName: row.artist_name,
    albumId: row.album_id,
    albumTitle: row.album_title,
    trackTitle: row.track_title,
    genres: row.genres ?? [],
    addedAt: serialiseTimestamp(row.added_at),
    lastPlayedAt: serialiseTimestamp(row.last_played_at),
    rating: row.rating === null ? null : Number(row.rating),
    playCount: row.play_count ?? 0,
    durationMs: row.duration_ms,
    plexRatingKey: row.plex_rating_key,
  }))
}

export async function beginRecommendationRun(
  database: Database,
  userId: string,
  kind: RecommendationKind,
  algorithmVersion: string,
): Promise<string> {
  const rows = await database<Array<{ id: string }>>`
    INSERT INTO recommendation_runs (user_id, kind, algorithm_version, status)
    VALUES (${userId}, ${kind}, ${algorithmVersion}, 'running')
    RETURNING id
  `
  const run = rows[0]
  if (!run) {
    throw new Error('Failed to create a recommendation run.')
  }
  return run.id
}

export async function completeRecommendationRun(
  database: Database,
  runId: string,
  recommendations: PersistedRecommendation[],
): Promise<void> {
  await database.begin(async (transaction) => {
    for (const recommendation of recommendations) {
      await transaction`
        INSERT INTO recommendations (run_id, track_id, rank, score, reason_codes, explanation_data)
        VALUES (
          ${runId},
          ${recommendation.trackId},
          ${recommendation.rank},
          ${recommendation.score},
          ${JSON.stringify(recommendation.reasons)}::jsonb,
          ${JSON.stringify({ summary: recommendation.summary })}::jsonb
        )
      `
    }
    await transaction`
      UPDATE recommendation_runs
      SET status = 'completed', completed_at = NOW()
      WHERE id = ${runId}
    `
  })
}

export async function failRecommendationRun(database: Database, runId: string, errorSummary: string): Promise<void> {
  await database`
    UPDATE recommendation_runs
    SET status = 'failed', completed_at = NOW(), error_summary = ${errorSummary.slice(0, 1_000)}
    WHERE id = ${runId}
  `
}

export async function getLatestRecommendations(
  database: Database,
  userId: string,
  kind?: RecommendationKind,
): Promise<LatestRecommendation[]> {
  const rows = await database<
    Array<{
      run_id: string
      kind: RecommendationKind
      algorithm_version: string
      created_at: Date | string
      track_id: string
      track_title: string
      artist_name: string
      album_title: string
      rank: number
      score: string | number
      reason_codes: object[]
      explanation_data: { summary?: string }
    }>
  >`
    WITH latest_runs AS (
      SELECT DISTINCT ON (kind) id, kind, algorithm_version, created_at
      FROM recommendation_runs
      WHERE user_id = ${userId}
        AND status = 'completed'
        AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null}::text)
      ORDER BY kind, created_at DESC
    )
    SELECT
      latest_runs.id AS run_id,
      latest_runs.kind,
      latest_runs.algorithm_version,
      latest_runs.created_at,
      t.id AS track_id,
      t.title AS track_title,
      artist.name AS artist_name,
      album.title AS album_title,
      recommendation.rank,
      recommendation.score,
      recommendation.reason_codes,
      recommendation.explanation_data
    FROM latest_runs
    JOIN recommendations recommendation ON recommendation.run_id = latest_runs.id
    JOIN tracks t ON t.id = recommendation.track_id
    JOIN albums album ON album.id = t.album_id
    JOIN artists artist ON artist.id = album.artist_id
    ORDER BY latest_runs.created_at DESC, recommendation.rank ASC
  `

  return rows.map((row) => ({
    runId: row.run_id,
    kind: row.kind,
    algorithmVersion: row.algorithm_version,
    createdAt: serialiseTimestamp(row.created_at) ?? new Date(0).toISOString(),
    trackId: row.track_id,
    trackTitle: row.track_title,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    rank: row.rank,
    score: Number(row.score),
    reasons: row.reason_codes,
    summary: row.explanation_data.summary ?? '',
  }))
}

export async function getOwnerUserIds(database: Database): Promise<string[]> {
  const rows = await database<Array<{ id: string }>>`
    SELECT id
    FROM users
    WHERE role = 'owner' AND disabled_at IS NULL
    ORDER BY created_at ASC
  `
  return rows.map((row) => row.id)
}

export async function getUserTimezone(database: Database, userId: string): Promise<string> {
  const rows = await database<Array<{ timezone: string }>>`
    SELECT timezone
    FROM users
    WHERE id = ${userId} AND disabled_at IS NULL
    LIMIT 1
  `
  return rows[0]?.timezone ?? 'UTC'
}

export async function getDailyBriefForDate(
  database: Database,
  userId: string,
  briefDate: string,
): Promise<DailyBriefRecord | null> {
  const rows = await database<DailyBriefRow[]>`
    SELECT
      brief.id,
      brief.brief_date,
      brief.timezone,
      brief.algorithm_version,
      brief.content,
      brief.created_at,
      delivery.status AS delivery_status,
      delivery.attempt_count AS delivery_attempt_count,
      delivery.last_attempt_at AS delivery_last_attempt_at,
      delivery.delivered_at AS delivery_delivered_at,
      delivery.error_summary AS delivery_error_summary
    FROM daily_briefs brief
    LEFT JOIN daily_brief_deliveries delivery
      ON delivery.daily_brief_id = brief.id AND delivery.destination = 'discord'
    WHERE brief.user_id = ${userId} AND brief.brief_date = ${briefDate}::date
    ORDER BY brief.created_at DESC
    LIMIT 1
  `
  return rows[0] ? mapDailyBrief(rows[0]) : null
}

export async function getLatestDailyBrief(database: Database, userId: string): Promise<DailyBriefRecord | null> {
  const rows = await database<DailyBriefRow[]>`
    SELECT
      brief.id,
      brief.brief_date,
      brief.timezone,
      brief.algorithm_version,
      brief.content,
      brief.created_at,
      delivery.status AS delivery_status,
      delivery.attempt_count AS delivery_attempt_count,
      delivery.last_attempt_at AS delivery_last_attempt_at,
      delivery.delivered_at AS delivery_delivered_at,
      delivery.error_summary AS delivery_error_summary
    FROM daily_briefs brief
    LEFT JOIN daily_brief_deliveries delivery
      ON delivery.daily_brief_id = brief.id AND delivery.destination = 'discord'
    WHERE brief.user_id = ${userId}
    ORDER BY brief.brief_date DESC, brief.created_at DESC
    LIMIT 1
  `
  return rows[0] ? mapDailyBrief(rows[0]) : null
}

export async function createDailyBrief(
  database: Database,
  input: {
    userId: string
    briefDate: string
    timezone: string
    algorithmVersion: string
    content: DailyBriefContent
  },
): Promise<DailyBriefRecord> {
  const rows = await database<DailyBriefRow[]>`
    INSERT INTO daily_briefs (user_id, brief_date, timezone, algorithm_version, content)
    VALUES (
      ${input.userId},
      ${input.briefDate}::date,
      ${input.timezone},
      ${input.algorithmVersion},
      ${JSON.stringify(input.content)}::jsonb
    )
    ON CONFLICT (user_id, brief_date, algorithm_version) DO NOTHING
    RETURNING id, brief_date, timezone, algorithm_version, content, created_at,
      NULL::daily_brief_delivery_status AS delivery_status,
      NULL::integer AS delivery_attempt_count,
      NULL::timestamptz AS delivery_last_attempt_at,
      NULL::timestamptz AS delivery_delivered_at,
      NULL::text AS delivery_error_summary
  `
  if (rows[0]) {
    return mapDailyBrief(rows[0])
  }

  const existing = await getDailyBriefForDate(database, input.userId, input.briefDate)
  if (!existing) {
    throw new Error('Daily briefing could not be created.')
  }
  return existing
}

export async function getDailyBriefDelivery(database: Database, briefId: string): Promise<DailyBriefDelivery | null> {
  const rows = await database<DailyBriefDeliveryRow[]>`
    SELECT status, attempt_count, last_attempt_at, delivered_at, error_summary
    FROM daily_brief_deliveries
    WHERE daily_brief_id = ${briefId} AND destination = 'discord'
    LIMIT 1
  `
  return rows[0] ? mapDailyBriefDelivery(rows[0]) : null
}

export async function beginDiscordDailyBriefDelivery(database: Database, briefId: string): Promise<DailyBriefDelivery> {
  const rows = await database<DailyBriefDeliveryRow[]>`
    INSERT INTO daily_brief_deliveries (
      daily_brief_id, destination, status, attempt_count, last_attempt_at, error_summary
    )
    VALUES (${briefId}, 'discord', 'pending', 1, NOW(), NULL)
    ON CONFLICT (daily_brief_id, destination) DO UPDATE
    SET status = 'pending',
      attempt_count = daily_brief_deliveries.attempt_count + 1,
      last_attempt_at = NOW(),
      error_summary = NULL,
      updated_at = NOW()
    RETURNING status, attempt_count, last_attempt_at, delivered_at, error_summary
  `
  const delivery = rows[0]
  if (!delivery) {
    throw new Error('Daily briefing delivery could not be prepared.')
  }
  return mapDailyBriefDelivery(delivery)
}

export async function completeDiscordDailyBriefDelivery(database: Database, briefId: string): Promise<void> {
  await database`
    UPDATE daily_brief_deliveries
    SET status = 'delivered', delivered_at = NOW(), error_summary = NULL, updated_at = NOW()
    WHERE daily_brief_id = ${briefId} AND destination = 'discord'
  `
}

export async function failDiscordDailyBriefDelivery(
  database: Database,
  briefId: string,
  errorSummary: string,
): Promise<void> {
  await database`
    UPDATE daily_brief_deliveries
    SET status = 'failed', error_summary = ${errorSummary.slice(0, 1_000)}, updated_at = NOW()
    WHERE daily_brief_id = ${briefId} AND destination = 'discord'
  `
}

export async function getDashboardOverview(database: Database, userId: string): Promise<DashboardOverview> {
  const [libraryRows, listeningRows, artistRows, genreRows, syncRows, dailyMix] = await Promise.all([
    database<
      Array<{
        artist_count: number | string
        album_count: number | string
        track_count: number | string
        total_duration_ms: number | string
        newest_added_at: Date | string | null
      }>
    >`
      SELECT
        COUNT(DISTINCT artist.id)::integer AS artist_count,
        COUNT(DISTINCT album.id)::integer AS album_count,
        COUNT(track.id)::integer AS track_count,
        COALESCE(SUM(track.duration_ms), 0)::bigint AS total_duration_ms,
        MAX(track.added_at) AS newest_added_at
      FROM tracks track
      JOIN albums album ON album.id = track.album_id
      JOIN artists artist ON artist.id = album.artist_id
    `,
    database<
      Array<{
        total_play_count: number | string
        played_track_count: number | string
        rated_track_count: number | string
        last_played_at: Date | string | null
      }>
    >`
      SELECT
        COALESCE(SUM(play_count), 0)::bigint AS total_play_count,
        COUNT(*) FILTER (WHERE play_count > 0)::integer AS played_track_count,
        COUNT(*) FILTER (WHERE rating IS NOT NULL)::integer AS rated_track_count,
        MAX(last_played_at) AS last_played_at
      FROM user_item_state
      WHERE user_id = ${userId} AND entity_type = 'track'
    `,
    database<Array<{ id: string; name: string; play_count: number | string }>>`
      SELECT artist.id, artist.name, COALESCE(SUM(state.play_count), 0)::bigint AS play_count
      FROM user_item_state state
      JOIN tracks track ON track.id = state.entity_id
      JOIN albums album ON album.id = track.album_id
      JOIN artists artist ON artist.id = album.artist_id
      WHERE state.user_id = ${userId} AND state.entity_type = 'track'
      GROUP BY artist.id, artist.name
      HAVING COALESCE(SUM(state.play_count), 0) > 0
      ORDER BY play_count DESC, artist.name ASC
      LIMIT 5
    `,
    database<Array<{ id: string; name: string; play_count: number | string }>>`
      SELECT genre.id, genre.display_name AS name, COALESCE(SUM(state.play_count), 0)::bigint AS play_count
      FROM user_item_state state
      JOIN item_genres item_genre
        ON item_genre.entity_type = 'track' AND item_genre.entity_id = state.entity_id
      JOIN genres genre ON genre.id = item_genre.genre_id
      WHERE state.user_id = ${userId} AND state.entity_type = 'track'
      GROUP BY genre.id, genre.display_name
      HAVING COALESCE(SUM(state.play_count), 0) > 0
      ORDER BY play_count DESC, genre.display_name ASC
      LIMIT 5
    `,
    database<
      Array<{
        status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
        finished_at: Date | string | null
        error_summary: string | null
      }>
    >`
      SELECT status, finished_at, error_summary
      FROM sync_runs
      ORDER BY created_at DESC
      LIMIT 1
    `,
    getLatestRecommendations(database, userId, 'daily_mix'),
  ])

  const library = libraryRows[0]
  const listening = listeningRows[0]
  const sync = syncRows[0]

  return {
    library: {
      artistCount: numericValue(library?.artist_count),
      albumCount: numericValue(library?.album_count),
      trackCount: numericValue(library?.track_count),
      totalDurationMs: numericValue(library?.total_duration_ms),
      newestAddedAt: serialiseTimestamp(library?.newest_added_at ?? null),
    },
    listening: {
      totalPlayCount: numericValue(listening?.total_play_count),
      playedTrackCount: numericValue(listening?.played_track_count),
      ratedTrackCount: numericValue(listening?.rated_track_count),
      lastPlayedAt: serialiseTimestamp(listening?.last_played_at ?? null),
    },
    favourites: {
      artists: artistRows.map((artist) => ({
        id: artist.id,
        name: artist.name,
        playCount: numericValue(artist.play_count),
      })),
      genres: genreRows.map((genre) => ({
        id: genre.id,
        name: genre.name,
        playCount: numericValue(genre.play_count),
      })),
    },
    sync: sync
      ? {
          status: sync.status,
          lastCompletedAt: sync.status === 'completed' ? serialiseTimestamp(sync.finished_at) : null,
          errorSummary: sync.error_summary,
        }
      : { status: 'not_started', lastCompletedAt: null, errorSummary: null },
    dailyMix,
  }
}

export async function getListeningInsightSummary(
  database: Database,
  userId: string,
  timezone: string,
  days = 30,
): Promise<ListeningInsightSummary> {
  const endDate = dateInTimezone(new Date(), timezone)
  const startDate = subtractCalendarDays(endDate, days - 1)
  const [totalsRows, artistRows] = await Promise.all([
    database<
      Array<{
        reported_plays: number | string
        exact_plays: number | string
        observed_plays: number | string
        estimated_listened_ms: number | string
        unique_tracks: number | string
        unique_artists: number | string
      }>
    >`
      SELECT
        COALESCE((
          SELECT SUM(track_rollup.reported_plays)
          FROM user_track_rollups track_rollup
          WHERE track_rollup.user_id = ${userId}
            AND track_rollup.period_kind = 'day'
            AND track_rollup.period_start BETWEEN ${startDate}::date AND ${endDate}::date
        ), 0)::bigint AS reported_plays,
        COALESCE((
          SELECT SUM(track_rollup.exact_plays)
          FROM user_track_rollups track_rollup
          WHERE track_rollup.user_id = ${userId}
            AND track_rollup.period_kind = 'day'
            AND track_rollup.period_start BETWEEN ${startDate}::date AND ${endDate}::date
        ), 0)::bigint AS exact_plays,
        COALESCE((
          SELECT SUM(track_rollup.observed_plays)
          FROM user_track_rollups track_rollup
          WHERE track_rollup.user_id = ${userId}
            AND track_rollup.period_kind = 'day'
            AND track_rollup.period_start BETWEEN ${startDate}::date AND ${endDate}::date
        ), 0)::bigint AS observed_plays,
        COALESCE((
          SELECT SUM(track_rollup.estimated_listened_ms)
          FROM user_track_rollups track_rollup
          WHERE track_rollup.user_id = ${userId}
            AND track_rollup.period_kind = 'day'
            AND track_rollup.period_start BETWEEN ${startDate}::date AND ${endDate}::date
        ), 0)::bigint AS estimated_listened_ms,
        COALESCE((
          SELECT COUNT(DISTINCT track_rollup.track_id)
          FROM user_track_rollups track_rollup
          WHERE track_rollup.user_id = ${userId}
            AND track_rollup.period_kind = 'day'
            AND track_rollup.period_start BETWEEN ${startDate}::date AND ${endDate}::date
        ), 0)::integer AS unique_tracks,
        COALESCE((
          SELECT COUNT(DISTINCT artist_rollup.artist_id)
          FROM user_artist_rollups artist_rollup
          WHERE artist_rollup.user_id = ${userId}
            AND artist_rollup.period_kind = 'day'
            AND artist_rollup.period_start BETWEEN ${startDate}::date AND ${endDate}::date
        ), 0)::integer AS unique_artists
    `,
    database<Array<{ id: string; name: string; play_count: number | string }>>`
      SELECT artist.id, artist.name, COALESCE(SUM(rollup.reported_plays), 0)::bigint AS play_count
      FROM user_artist_rollups rollup
      JOIN artists artist ON artist.id = rollup.artist_id
      WHERE rollup.user_id = ${userId}
        AND rollup.period_kind = 'day'
        AND rollup.period_start BETWEEN ${startDate}::date AND ${endDate}::date
      GROUP BY artist.id, artist.name
      HAVING COALESCE(SUM(rollup.reported_plays), 0) > 0
      ORDER BY play_count DESC, artist.name ASC
      LIMIT 5
    `,
  ])

  const totals = totalsRows[0]
  const reportedPlays = numericValue(totals?.reported_plays)
  const exactPlays = numericValue(totals?.exact_plays)
  const observedPlays = numericValue(totals?.observed_plays)

  return {
    period: { startDate, endDate, timezone },
    playback: {
      reportedPlays,
      exactPlays,
      observedPlays,
      estimatedListenedMs: numericValue(totals?.estimated_listened_ms),
      uniqueTracks: numericValue(totals?.unique_tracks),
      uniqueArtists: numericValue(totals?.unique_artists),
      coverage: listeningCoverage(exactPlays, observedPlays),
    },
    topArtists: artistRows.map((artist) => ({
      id: artist.id,
      name: artist.name,
      playCount: numericValue(artist.play_count),
    })),
  }
}

function normaliseGenre(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`
}

function subtractCalendarDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function listeningCoverage(exactPlays: number, observedPlays: number): ListeningCoverage {
  if (exactPlays > 0 && observedPlays > 0) {
    return 'mixed'
  }
  if (exactPlays > 0) {
    return 'exact'
  }
  if (observedPlays > 0) {
    return 'observed'
  }
  return 'none'
}

type DailyBriefRow = {
  id: string
  brief_date: string | Date
  timezone: string
  algorithm_version: string
  content: DailyBriefContent
  created_at: Date | string
  delivery_status: DailyBriefDeliveryStatus | null
  delivery_attempt_count: number | string | null
  delivery_last_attempt_at: Date | string | null
  delivery_delivered_at: Date | string | null
  delivery_error_summary: string | null
}

type DailyBriefDeliveryRow = {
  status: DailyBriefDeliveryStatus
  attempt_count: number | string
  last_attempt_at: Date | string | null
  delivered_at: Date | string | null
  error_summary: string | null
}

function mapDailyBrief(row: DailyBriefRow): DailyBriefRecord {
  return {
    id: row.id,
    briefDate: row.brief_date instanceof Date ? row.brief_date.toISOString().slice(0, 10) : row.brief_date,
    timezone: row.timezone,
    algorithmVersion: row.algorithm_version,
    content: row.content,
    createdAt: serialiseTimestamp(row.created_at) ?? new Date(0).toISOString(),
    discordDelivery: row.delivery_status
      ? mapDailyBriefDelivery({
          status: row.delivery_status,
          attempt_count: row.delivery_attempt_count ?? 0,
          last_attempt_at: row.delivery_last_attempt_at,
          delivered_at: row.delivery_delivered_at,
          error_summary: row.delivery_error_summary,
        })
      : null,
  }
}

function mapDailyBriefDelivery(row: DailyBriefDeliveryRow): DailyBriefDelivery {
  return {
    status: row.status,
    attemptCount: numericValue(row.attempt_count),
    lastAttemptAt: serialiseTimestamp(row.last_attempt_at),
    deliveredAt: serialiseTimestamp(row.delivered_at),
    errorSummary: row.error_summary,
  }
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

function numericValue(value: number | string | null | undefined): number {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0
}

type SyncRunRow = {
  id: string
  library_section_id: string | null
  library_title: string | null
  kind: string
  status: SyncRunRecord['status']
  counts: unknown
  error_summary: string | null
  started_at: Date | string | null
  finished_at: Date | string | null
  created_at: Date | string
}

function toSyncRunRecord(row: SyncRunRow): SyncRunRecord {
  const failure = row.error_summary ? parseStoredSyncFailure(row.error_summary) : null
  return {
    id: row.id,
    librarySectionId: row.library_section_id,
    libraryTitle: row.library_title,
    kind: row.kind,
    status: row.status,
    counts: parseSyncCounts(row.counts),
    startedAt: serialiseTimestamp(row.started_at),
    finishedAt: serialiseTimestamp(row.finished_at),
    createdAt: serialiseTimestamp(row.created_at) ?? new Date(0).toISOString(),
    failure,
  }
}

function parseSyncCounts(value: unknown): { importedTracks: number; skippedTracks: number } {
  const counts = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    importedTracks: nonNegativeInteger(counts.importedTracks),
    skippedTracks: nonNegativeInteger(counts.skippedTracks),
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function sanitiseSyncFailure(error: unknown): string {
  const classification = classifySyncFailure(error)
  return `${classification}: ${safeFailureSummary(classification)}`
}

function classifySyncFailure(error: unknown): SyncFailureClassification {
  if (hasSyncFailureClassification(error)) return error.classification
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('encryption') || message.includes('configuration') || message.includes('required before')) return 'configuration'
  if (message.includes('unauthor') || message.includes('forbidden') || message.includes('credential') || message.includes('token')) return 'authentication'
  if (message.includes('timeout') || message.includes('network') || message.includes('connect') || message.includes('unavailable')) return 'upstream_unavailable'
  if (message.includes('plex') || message.includes('response') || message.includes('parse')) return 'upstream_response'
  return 'unknown'
}

function hasSyncFailureClassification(error: unknown): error is { classification: SyncFailureClassification } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'classification' in error &&
    ['configuration', 'authentication', 'upstream_unavailable', 'upstream_response', 'unknown'].includes(
      (error as { classification?: unknown }).classification as string,
    )
  )
}

function safeFailureSummary(classification: SyncFailureClassification): string {
  switch (classification) {
    case 'configuration': return 'Sync configuration needs attention.'
    case 'authentication': return 'Plex authentication was rejected.'
    case 'upstream_unavailable': return 'Plex is temporarily unavailable.'
    case 'upstream_response': return 'Plex returned an unexpected response.'
    default: return 'The sync did not complete.'
  }
}

function parseStoredSyncFailure(value: string): SyncRunRecord['failure'] {
  const match = /^(configuration|authentication|upstream_unavailable|upstream_response|unknown): (.+)$/.exec(value)
  if (!match) return { classification: 'unknown', summary: 'The sync did not complete.' }
  return { classification: match[1] as SyncFailureClassification, summary: match[2] ?? 'The sync did not complete.' }
}

/** Current session version for an active user, or null when the user is missing or disabled. */
export async function getSessionVersion(database: Database, userId: string): Promise<number | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null
  const rows = await database<Array<{ session_version: number }>>`
    SELECT session_version FROM users WHERE id = ${userId}::uuid AND disabled_at IS NULL LIMIT 1
  `
  return rows[0]?.session_version ?? null
}

/**
 * Invalidates every session token issued for the user at the given version. Conditional on
 * the stored version still matching, so a stale or already-revoked token cannot bump it again.
 */
export async function revokeUserSessions(database: Database, userId: string, expectedVersion: number): Promise<void> {
  await database`
    UPDATE users SET session_version = session_version + 1
    WHERE id = ${userId}::uuid AND session_version = ${expectedVersion}
  `
}
