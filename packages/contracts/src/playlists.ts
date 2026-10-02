import { z } from 'zod'
import { noNul } from './text.js'

/**
 * A generated playlist is an eventually-consistent object. Items that already
 * exist in the Plex mirror are immediately publishable; items that have to be
 * acquired through Lidarr move through an acquisition state machine and become
 * publishable only after a later `library.sync` mirrors the imported track and
 * gives Musearr a Plex `ratingKey` for it.
 *
 *   in_library ─┐
 *   pending → requested → downloading → imported → matched ─┼─→ (publishable)
 *                                                unavailable ┘  (skipped, generation stays open)
 */
export const PlaylistGenerationItemStateSchema = z.enum([
  'in_library',
  'pending',
  'requested',
  'downloading',
  'imported',
  'matched',
  'unavailable',
])

export const PlaylistGenerationStatusSchema = z.enum([
  'generating',
  'awaiting_acquisition',
  'ready',
  'publishing',
  'published',
  'partially_published',
  'failed',
])

export const GeneratePlaylistRequestSchema = z.object({
  seedTrackId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).refine(noNul).optional(),
  targetSize: z.number().int().min(5).max(100).default(25),
  /** Ask Lidarr to acquire suggestions that are not already in the library. */
  acquireMissing: z.boolean().default(false),
  /** Publish the finished playlist back to Plex as a Musearr-managed playlist. */
  publishToPlex: z.boolean().default(false),
})

export const PlaylistGenerationReasonSchema = z.object({
  code: z.string(),
  weight: z.number(),
  facts: z.record(z.string(), z.union([z.string(), z.number()])),
})

export const PlaylistGenerationItemSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  trackId: z.string().uuid().nullable(),
  trackTitle: z.string(),
  artistName: z.string(),
  albumTitle: z.string().nullable(),
  state: PlaylistGenerationItemStateSchema,
  inLibrary: z.boolean(),
  score: z.number().min(0).max(1),
  reasons: z.array(PlaylistGenerationReasonSchema),
})

export const PlaylistGenerationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  seedTrackId: z.string().uuid().nullable(),
  seedLabel: z.string(),
  status: PlaylistGenerationStatusSchema,
  algorithmVersion: z.string(),
  targetSize: z.number().int().positive(),
  acquireMissing: z.boolean(),
  publishToPlex: z.boolean(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    inLibrary: z.number().int().nonnegative(),
    awaitingAcquisition: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
  }),
  plexPlaylistRatingKey: z.string().nullable(),
  errorSummary: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  items: z.array(PlaylistGenerationItemSchema),
})

export const PlaylistGenerationSummarySchema = PlaylistGenerationSchema.omit({ items: true })

export const PlaylistGenerationResponseSchema = z.object({ generation: PlaylistGenerationSchema })
export const PlaylistGenerationListResponseSchema = z.object({
  generations: z.array(PlaylistGenerationSummarySchema),
})
export const PlaylistGenerationAcceptedSchema = z.object({
  generationId: z.string().uuid(),
  status: PlaylistGenerationStatusSchema,
})

export type PlaylistGenerationItemState = z.infer<typeof PlaylistGenerationItemStateSchema>
export type PlaylistGenerationStatus = z.infer<typeof PlaylistGenerationStatusSchema>
export type GeneratePlaylistRequest = z.infer<typeof GeneratePlaylistRequestSchema>
export type PlaylistGenerationItem = z.infer<typeof PlaylistGenerationItemSchema>
export type PlaylistGeneration = z.infer<typeof PlaylistGenerationSchema>
export type PlaylistGenerationSummary = z.infer<typeof PlaylistGenerationSummarySchema>
export type PlaylistGenerationResponse = z.infer<typeof PlaylistGenerationResponseSchema>
export type PlaylistGenerationListResponse = z.infer<typeof PlaylistGenerationListResponseSchema>
export type PlaylistGenerationAccepted = z.infer<typeof PlaylistGenerationAcceptedSchema>
