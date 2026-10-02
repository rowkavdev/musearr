import { z } from 'zod'
import { noNul } from './text.js'

export * from './lidarr.js'
export * from './local-ai.js'
export * from './musicbrainz.js'
export * from './playlists.js'

export const SetupPhaseSchema = z.enum(['unconfigured', 'configured'])

export const SystemStatusSchema = z.object({
  status: z.enum(['healthy', 'degraded']),
  version: z.string(),
  database: z.enum(['connected', 'unavailable']),
  checkedAt: z.string().datetime(),
})

export const SetupStatusSchema = z.object({
  phase: SetupPhaseSchema,
  plexServer: z
    .object({
      name: z.string(),
      machineIdentifier: z.string(),
      lastSeenAt: z.string().datetime().nullable(),
    })
    .nullable(),
})

export const PlexConnectionRequestSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  token: z.string().trim().min(8).max(4096),
})

export const PlexLibrarySectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.literal('artist'),
})

export const PlexConnectionResultSchema = z.object({
  machineIdentifier: z.string(),
  serverName: z.string(),
  version: z.string().nullable(),
  musicLibraries: z.array(PlexLibrarySectionSchema),
})

export const PlexPinCreateResponseSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1),
  authUrl: z.string().url(),
})

export const PlexAuthorizedServerSchema = z.object({
  name: z.string(),
  machineIdentifier: z.string(),
  baseUrl: z.string().url(),
})

export const PlexPinStatusResponseSchema = z.object({
  authToken: z.string().nullable(),
  servers: z.array(PlexAuthorizedServerSchema),
})

const PlexWebhookSectionIdSchema = z
  .union([z.string().trim().min(1).max(64), z.number().int().nonnegative()])
  .transform(String)

export const PlexWebhookPayloadSchema = z
  .object({
    event: z.string().trim().min(1).max(128),
    Server: z
      .object({
        uuid: z.string().trim().min(1).max(256),
      })
      .passthrough()
      .optional(),
    Metadata: z
      .object({
        librarySectionID: PlexWebhookSectionIdSchema.optional(),
        librarySectionType: z.string().trim().max(64).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const CompleteSetupRequestSchema = PlexConnectionRequestSchema.extend({
  ownerUsername: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dots, underscores, or hyphens.'),
  ownerPassword: z.string().min(12).max(1024),
  selectedLibraryIds: z.array(z.string().min(1).max(64)).min(1).max(50),
})

export const QueueLibrarySyncRequestSchema = z.object({
  librarySectionId: z.string().uuid().optional(),
})

export const RecommendationKindSchema = z.enum(['daily_mix', 'forgotten_favourites', 'hidden_gems', 'recently_added'])

export const QueueRecommendationRunRequestSchema = z.object({
  kind: RecommendationKindSchema,
  limit: z.number().int().min(1).max(100).default(30),
})

export const RecommendationQuerySchema = z.object({
  kind: RecommendationKindSchema.optional(),
})

const DashboardFavouriteSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  playCount: z.number().nonnegative(),
})

const DashboardRecommendationSchema = z.object({
  runId: z.string().uuid(),
  kind: RecommendationKindSchema,
  algorithmVersion: z.string(),
  createdAt: z.string().datetime(),
  trackId: z.string().uuid(),
  trackTitle: z.string(),
  artistName: z.string(),
  albumTitle: z.string(),
  rank: z.number().int().positive(),
  score: z.number().min(0).max(1),
  reasons: z.array(z.unknown()),
  summary: z.string(),
})

export const DashboardOverviewSchema = z.object({
  library: z.object({
    artistCount: z.number().int().nonnegative(),
    albumCount: z.number().int().nonnegative(),
    trackCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().nonnegative(),
    newestAddedAt: z.string().datetime().nullable(),
  }),
  listening: z.object({
    totalPlayCount: z.number().nonnegative(),
    playedTrackCount: z.number().int().nonnegative(),
    ratedTrackCount: z.number().int().nonnegative(),
    lastPlayedAt: z.string().datetime().nullable(),
  }),
  favourites: z.object({
    artists: z.array(DashboardFavouriteSchema),
    genres: z.array(DashboardFavouriteSchema),
  }),
  sync: z.object({
    status: z.enum(['not_started', 'queued', 'running', 'completed', 'failed', 'cancelled']),
    lastCompletedAt: z.string().datetime().nullable(),
    errorSummary: z.string().nullable(),
  }),
  dailyMix: z.array(DashboardRecommendationSchema),
})

export const DailyBriefCardSchema = z.object({
  kind: z.enum(['daily_mix', 'favourite_artist', 'favourite_genre', 'library', 'sync']),
  title: z.string().min(1).max(280),
  body: z.string().min(1).max(2_000),
})

export const DailyBriefDeliverySchema = z.object({
  status: z.enum(['pending', 'delivered', 'failed']),
  attemptCount: z.number().int().nonnegative(),
  lastAttemptAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  errorSummary: z.string().nullable(),
})

export const DailyBriefSchema = z.object({
  id: z.string().uuid(),
  briefDate: z.string().date(),
  timezone: z.string().min(1),
  algorithmVersion: z.string().min(1),
  content: z.object({
    headline: z.string().min(1).max(280),
    summary: z.string().min(1).max(2_000),
    cards: z.array(DailyBriefCardSchema).min(1).max(4),
  }),
  createdAt: z.string().datetime(),
  discordDelivery: DailyBriefDeliverySchema.nullable(),
})

export const DailyBriefResponseSchema = z.object({
  brief: DailyBriefSchema.nullable(),
})

export const ScrobbleItemSchema = z.object({
  artistName: z.string().trim().min(1).refine(noNul),
  trackTitle: z.string().trim().min(1).refine(noNul),
  albumTitle: z.string().trim().refine(noNul).optional(),
  occurredAt: z.string().datetime(),
})

export const ScrobbleImportRequestSchema = z.object({
  scrobbles: z.array(ScrobbleItemSchema).min(1).max(5000),
})

export const ScrobbleImportResponseSchema = z.object({
  importedCount: z.number().int().nonnegative(),
  matchedTracksCount: z.number().int().nonnegative(),
  unmatchedCount: z.number().int().nonnegative(),
})

export type ScrobbleItem = z.infer<typeof ScrobbleItemSchema>
export type ScrobbleImportRequest = z.infer<typeof ScrobbleImportRequestSchema>
export type ScrobbleImportResponse = z.infer<typeof ScrobbleImportResponseSchema>

export const PlaylistProposalItemSchema = z.object({
  trackId: z.string().uuid(),
  trackTitle: z.string(),
  artistName: z.string(),
  albumTitle: z.string(),
  durationMs: z.number().nullable(),
  plexRatingKey: z.string(),
  position: z.number().int().nonnegative(),
})

export const PlaylistProposalSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  kind: z.string(),
  algorithmVersion: z.string(),
  status: z.enum(['draft', 'exported', 'dismissed']),
  plexPlaylistRatingKey: z.string().nullable(),
  createdAt: z.string().datetime(),
  items: z.array(PlaylistProposalItemSchema),
})

export const CreatePlaylistProposalRequestSchema = z.object({
  kind: RecommendationKindSchema.default('daily_mix'),
  title: z.string().trim().min(1).max(280).refine(noNul).optional(),
  limit: z.number().int().min(5).max(100).default(20),
})

export const PlaylistProposalListResponseSchema = z.object({
  proposals: z.array(PlaylistProposalSchema),
})

export type PlaylistProposalItem = z.infer<typeof PlaylistProposalItemSchema>
export type PlaylistProposal = z.infer<typeof PlaylistProposalSchema>
export type CreatePlaylistProposalRequest = z.infer<typeof CreatePlaylistProposalRequestSchema>

export const ListeningInsightQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
})

const ListeningCoverageSchema = z.enum(['none', 'exact', 'observed', 'mixed'])

export const ListeningInsightSummarySchema = z.object({
  period: z.object({
    startDate: z.string().date(),
    endDate: z.string().date(),
    timezone: z.string().min(1),
  }),
  playback: z.object({
    reportedPlays: z.number().int().nonnegative(),
    exactPlays: z.number().int().nonnegative(),
    observedPlays: z.number().int().nonnegative(),
    estimatedListenedMs: z.number().nonnegative(),
    uniqueTracks: z.number().int().nonnegative(),
    uniqueArtists: z.number().int().nonnegative(),
    coverage: ListeningCoverageSchema,
  }),
  topArtists: z.array(DashboardFavouriteSchema),
})

export type SetupPhase = z.infer<typeof SetupPhaseSchema>
export type SystemStatus = z.infer<typeof SystemStatusSchema>
export type SetupStatus = z.infer<typeof SetupStatusSchema>
export type PlexConnectionRequest = z.infer<typeof PlexConnectionRequestSchema>
export type PlexLibrarySection = z.infer<typeof PlexLibrarySectionSchema>
export type PlexConnectionResult = z.infer<typeof PlexConnectionResultSchema>
export type PlexPinCreateResponse = z.infer<typeof PlexPinCreateResponseSchema>
export type PlexAuthorizedServer = z.infer<typeof PlexAuthorizedServerSchema>
export type PlexPinStatusResponse = z.infer<typeof PlexPinStatusResponseSchema>
export type PlexWebhookPayload = z.infer<typeof PlexWebhookPayloadSchema>
export type CompleteSetupRequest = z.infer<typeof CompleteSetupRequestSchema>
export type QueueLibrarySyncRequest = z.infer<typeof QueueLibrarySyncRequestSchema>
export type RecommendationKind = z.infer<typeof RecommendationKindSchema>
export type QueueRecommendationRunRequest = z.infer<typeof QueueRecommendationRunRequestSchema>
export type DashboardOverview = z.infer<typeof DashboardOverviewSchema>
export type DailyBrief = z.infer<typeof DailyBriefSchema>
export type DailyBriefResponse = z.infer<typeof DailyBriefResponseSchema>
export type ListeningInsightSummary = z.infer<typeof ListeningInsightSummarySchema>


export const SyncFailureClassificationSchema = z.enum([
  'configuration',
  'authentication',
  'upstream_unavailable',
  'upstream_response',
  'unknown',
])

export const SyncRunSchema = z.object({
  id: z.string().uuid(),
  librarySectionId: z.string().uuid().nullable(),
  libraryTitle: z.string().nullable(),
  kind: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  counts: z.object({
    importedTracks: z.number().int().nonnegative(),
    skippedTracks: z.number().int().nonnegative(),
  }),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  failure: z
    .object({
      classification: SyncFailureClassificationSchema,
      summary: z.string(),
    })
    .nullable(),
})

export const SyncRunListResponseSchema = z.object({ runs: z.array(SyncRunSchema) })
export const SyncRunResponseSchema = z.object({ run: SyncRunSchema })

export type SyncFailureClassification = z.infer<typeof SyncFailureClassificationSchema>
export type SyncRun = z.infer<typeof SyncRunSchema>
export type SyncRunListResponse = z.infer<typeof SyncRunListResponseSchema>
export type SyncRunResponse = z.infer<typeof SyncRunResponseSchema>
