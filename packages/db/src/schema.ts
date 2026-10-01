import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['owner', 'member'])
export const plexServerStatus = pgEnum('plex_server_status', ['connected', 'degraded', 'offline'])
export const syncRunStatus = pgEnum('sync_run_status', ['queued', 'running', 'completed', 'failed', 'cancelled'])
export const recommendationRunStatus = pgEnum('recommendation_run_status', ['running', 'completed', 'failed'])
export const dailyBriefDeliveryStatus = pgEnum('daily_brief_delivery_status', ['pending', 'delivered', 'failed'])
export const listeningEventType = pgEnum('listening_event_type', [
  'aggregate_checkpoint',
  'play_count_delta',
  'rating_change',
  'play_count_reset',
])
export const listeningEventPrecision = pgEnum('listening_event_precision', ['exact', 'observed', 'aggregate'])

export const instances = pgTable('instances', {
  id: uuid('id').defaultRandom().primaryKey(),
  timezone: text('timezone').notNull().default('UTC'),
  encryptionKeyVersion: text('encryption_key_version').notNull().default('v1'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('member'),
    timezone: text('timezone').notNull().default('UTC'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    sessionVersion: integer('session_version').notNull().default(0),
  },
  (table) => [uniqueIndex('users_username_key').on(table.username)],
)

export const plexServers = pgTable(
  'plex_servers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    machineIdentifier: text('machine_identifier').notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKeyVersion: text('token_key_version').notNull().default('v1'),
    status: plexServerStatus('status').notNull().default('connected'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('plex_servers_machine_identifier_key').on(table.machineIdentifier)],
)

export const librarySections = pgTable(
  'library_sections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    plexServerId: uuid('plex_server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
    plexSectionId: text('plex_section_id').notNull(),
    title: text('title').notNull(),
    type: text('type').notNull(),
    selected: boolean('selected').notNull().default(true),
    lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('library_sections_server_section_key').on(table.plexServerId, table.plexSectionId)],
)

export const artists = pgTable(
  'artists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    plexServerId: uuid('plex_server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
    plexRatingKey: text('plex_rating_key').notNull(),
    name: text('name').notNull(),
    sortName: text('sort_name'),
    thumbKey: text('thumb_key'),
    plexUpdatedAt: timestamp('plex_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('artists_server_rating_key').on(table.plexServerId, table.plexRatingKey)],
)

export const albums = pgTable(
  'albums',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    artistId: uuid('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    plexRatingKey: text('plex_rating_key').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    thumbKey: text('thumb_key'),
    plexUpdatedAt: timestamp('plex_updated_at', { withTimezone: true }),
    addedAt: timestamp('added_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('albums_artist_rating_key').on(table.artistId, table.plexRatingKey)],
)

export const tracks = pgTable(
  'tracks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    plexRatingKey: text('plex_rating_key').notNull(),
    title: text('title').notNull(),
    trackNumber: integer('track_number'),
    discNumber: integer('disc_number'),
    durationMs: integer('duration_ms'),
    addedAt: timestamp('added_at', { withTimezone: true }),
    plexUpdatedAt: timestamp('plex_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('tracks_album_rating_key').on(table.albumId, table.plexRatingKey)],
)

export const genres = pgTable('genres', {
  id: uuid('id').defaultRandom().primaryKey(),
  normalisedName: text('normalised_name').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const itemGenres = pgTable(
  'item_genres',
  {
    genreId: uuid('genre_id')
      .notNull()
      .references(() => genres.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('item_genres_unique_source').on(table.genreId, table.entityType, table.entityId, table.source),
  ],
)

export const userItemState = pgTable(
  'user_item_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    rating: numeric('rating', { precision: 4, scale: 1 }),
    playCount: integer('play_count').notNull().default(0),
    skipCount: integer('skip_count'),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    firstPlayedAt: timestamp('first_played_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_item_state_unique').on(table.userId, table.entityType, table.entityId)],
)

export const listeningEvents = pgTable(
  'listening_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    plexServerId: uuid('plex_server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
    sourceEventId: text('source_event_id').notNull().unique(),
    eventType: listeningEventType('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    playCountDelta: integer('play_count_delta').notNull().default(0),
    ratingBefore: numeric('rating_before', { precision: 4, scale: 1 }),
    ratingAfter: numeric('rating_after', { precision: 4, scale: 1 }),
    durationMs: integer('duration_ms'),
    timePrecision: listeningEventPrecision('time_precision').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (table) => [
    index('listening_events_user_occurred_idx').on(table.userId, table.occurredAt),
    index('listening_events_user_track_idx').on(table.userId, table.trackId, table.observedAt),
  ],
)

export const userTrackRollups = pgTable(
  'user_track_rollups',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    periodKind: text('period_kind').notNull().default('day'),
    reportedPlays: integer('reported_plays').notNull().default(0),
    exactPlays: integer('exact_plays').notNull().default(0),
    observedPlays: integer('observed_plays').notNull().default(0),
    estimatedListenedMs: bigint('estimated_listened_ms', { mode: 'number' }).notNull().default(0),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('user_track_rollups_key').on(table.userId, table.trackId, table.periodStart, table.periodKind),
    index('user_track_rollups_user_period_idx').on(table.userId, table.periodStart),
  ],
)

export const userArtistRollups = pgTable(
  'user_artist_rollups',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    artistId: uuid('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    periodKind: text('period_kind').notNull().default('day'),
    reportedPlays: integer('reported_plays').notNull().default(0),
    exactPlays: integer('exact_plays').notNull().default(0),
    observedPlays: integer('observed_plays').notNull().default(0),
    estimatedListenedMs: bigint('estimated_listened_ms', { mode: 'number' }).notNull().default(0),
    uniqueTracks: integer('unique_tracks').notNull().default(0),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('user_artist_rollups_key').on(table.userId, table.artistId, table.periodStart, table.periodKind),
    index('user_artist_rollups_user_period_idx').on(table.userId, table.periodStart),
  ],
)

export const playlists = pgTable(
  'playlists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    plexServerId: uuid('plex_server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
    plexRatingKey: text('plex_rating_key').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('user'),
    managedByMusearr: boolean('managed_by_musearr').notNull().default(false),
    revision: text('revision'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('playlists_server_rating_key').on(table.plexServerId, table.plexRatingKey),
    index('playlists_server_sync_idx').on(table.plexServerId, table.lastSyncedAt),
  ],
)

export const playlistItems = pgTable(
  'playlist_items',
  {
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    plexTrackRatingKey: text('plex_track_rating_key').notNull(),
    trackId: uuid('track_id').references(() => tracks.id, {
      onDelete: 'set null',
    }),
    addedAt: timestamp('added_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('playlist_items_playlist_position').on(table.playlistId, table.position),
    index('playlist_items_track_idx').on(table.trackId),
    index('playlist_items_unresolved_idx').on(table.plexTrackRatingKey),
  ],
)

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    plexServerId: uuid('plex_server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
    librarySectionId: uuid('library_section_id').references(() => librarySections.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    status: syncRunStatus('status').notNull().default('queued'),
    cursor: jsonb('cursor').notNull().default({}),
    counts: jsonb('counts').notNull().default({}),
    errorSummary: text('error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sync_runs_server_created_at_idx').on(table.plexServerId, table.createdAt)],
)

export const recommendationRuns = pgTable(
  'recommendation_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    inputSnapshotAt: timestamp('input_snapshot_at', { withTimezone: true }).notNull().defaultNow(),
    status: recommendationRunStatus('status').notNull().default('running'),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('recommendation_runs_user_kind_created_idx').on(table.userId, table.kind, table.createdAt)],
)

export const recommendations = pgTable(
  'recommendations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => recommendationRuns.id, { onDelete: 'cascade' }),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    score: numeric('score', { precision: 6, scale: 4 }).notNull(),
    reasonCodes: jsonb('reason_codes').notNull(),
    explanationData: jsonb('explanation_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('recommendations_run_rank_key').on(table.runId, table.rank),
    uniqueIndex('recommendations_run_track_key').on(table.runId, table.trackId),
  ],
)

export const dailyBriefs = pgTable(
  'daily_briefs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    briefDate: date('brief_date').notNull(),
    timezone: text('timezone').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('daily_briefs_user_date_idx').on(table.userId, table.briefDate, table.createdAt)],
)

export const dailyBriefDeliveries = pgTable(
  'daily_brief_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dailyBriefId: uuid('daily_brief_id')
      .notNull()
      .references(() => dailyBriefs.id, { onDelete: 'cascade' }),
    destination: text('destination').notNull(),
    status: dailyBriefDeliveryStatus('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('daily_brief_deliveries_brief_destination_key').on(table.dailyBriefId, table.destination),
    index('daily_brief_deliveries_status_idx').on(table.status, table.updatedAt),
  ],
)

export const playlistProposals = pgTable(
  'playlist_proposals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    status: text('status').notNull().default('draft'),
    plexPlaylistRatingKey: text('plex_playlist_rating_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('playlist_proposals_user_status_idx').on(table.userId, table.status, table.createdAt)],
)

export const playlistProposalItems = pgTable(
  'playlist_proposal_items',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => playlistProposals.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('playlist_proposal_items_pkey').on(table.proposalId, table.position),
    index('playlist_proposal_items_track_idx').on(table.trackId),
  ],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_target_idx').on(table.targetType, table.targetId)],
)

export const playlistGenerationStatus = pgEnum('playlist_generation_status', [
  'generating',
  'awaiting_acquisition',
  'ready',
  'publishing',
  'published',
  'partially_published',
  'failed',
])

export const playlistGenerationItemState = pgEnum('playlist_generation_item_state', [
  'in_library',
  'pending',
  'requested',
  'downloading',
  'imported',
  'matched',
  'unavailable',
])

export const lidarrConnections = pgTable(
  'lidarr_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    baseUrl: text('base_url').notNull(),
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    apiKeyKeyVersion: text('api_key_key_version').notNull().default('v1'),
    instanceName: text('instance_name'),
    version: text('version'),
    rootFolderPath: text('root_folder_path'),
    qualityProfileId: integer('quality_profile_id'),
    metadataProfileId: integer('metadata_profile_id'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('lidarr_connections_singleton').on(sql`(true)`)],
)

export const playlistGenerations = pgTable(
  'playlist_generations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seedTrackId: uuid('seed_track_id').references(() => tracks.id, { onDelete: 'set null' }),
    seedLabel: text('seed_label').notNull(),
    name: text('name').notNull(),
    status: playlistGenerationStatus('status').notNull().default('generating'),
    algorithmVersion: text('algorithm_version').notNull(),
    targetSize: integer('target_size').notNull(),
    acquireMissing: boolean('acquire_missing').notNull().default(false),
    publishToPlex: boolean('publish_to_plex').notNull().default(false),
    plexPlaylistId: uuid('plex_playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    inputSnapshotAt: timestamp('input_snapshot_at', { withTimezone: true }).notNull().defaultNow(),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [index('playlist_generations_user_created_idx').on(table.userId, table.createdAt)],
)

export const playlistGenerationItems = pgTable(
  'playlist_generation_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    generationId: uuid('generation_id')
      .notNull()
      .references(() => playlistGenerations.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    plexRatingKey: text('plex_rating_key'),
    artistName: text('artist_name').notNull(),
    albumTitle: text('album_title'),
    trackTitle: text('track_title').notNull(),
    state: playlistGenerationItemState('state').notNull().default('pending'),
    score: numeric('score', { precision: 6, scale: 4 }).notNull().default('0'),
    reasonCodes: jsonb('reason_codes').notNull().default([]),
    lidarrArtistId: integer('lidarr_artist_id'),
    lidarrAlbumId: integer('lidarr_album_id'),
    acquisitionRequestedAt: timestamp('acquisition_requested_at', { withTimezone: true }),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('playlist_generation_items_generation_position').on(table.generationId, table.position),
    index('playlist_generation_items_generation_idx').on(table.generationId),
    index('playlist_generation_items_state_idx').on(table.state),
  ],
)

export const playlistPublications = pgTable(
  'playlist_publications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    generationId: uuid('generation_id')
      .notNull()
      .references(() => playlistGenerations.id, { onDelete: 'cascade' }),
    plexServerId: uuid('plex_server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
    plexPlaylistRatingKey: text('plex_playlist_rating_key'),
    requestedItemCount: integer('requested_item_count').notNull().default(0),
    publishedItemCount: integer('published_item_count').notNull().default(0),
    status: text('status').notNull().default('pending'),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('playlist_publications_generation_idx').on(table.generationId, table.createdAt)],
)
