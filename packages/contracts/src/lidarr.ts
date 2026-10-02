import { z } from 'zod'
import { noNul } from './text.js'

/**
 * Lidarr is an optional, owner-configured acquisition backend. Musearr never
 * bundles a Lidarr instance; the owner points Musearr at one they already run.
 * The API key is a credential and is encrypted at rest, mirroring the Plex
 * token handling in {@link PlexConnectionRequestSchema}.
 */
export const LidarrConnectionRequestSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  apiKey: z.string().trim().min(8).max(512),
  rootFolderPath: z.string().trim().min(1).max(1024).refine(noNul).optional(),
  qualityProfileId: z.number().int().positive().optional(),
  metadataProfileId: z.number().int().positive().optional(),
})

export const LidarrConnectionResultSchema = z.object({
  version: z.string(),
  instanceName: z.string().nullable(),
  authenticated: z.literal(true),
  rootFolders: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      path: z.string(),
      freeSpaceBytes: z.number().nonnegative().nullable(),
    }),
  ),
  qualityProfiles: z.array(z.object({ id: z.number().int().nonnegative(), name: z.string() })),
  metadataProfiles: z.array(z.object({ id: z.number().int().nonnegative(), name: z.string() })),
})

export const LidarrConnectionStatusSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  instanceName: z.string().nullable(),
  version: z.string().nullable(),
  rootFolderPath: z.string().nullable(),
  qualityProfileId: z.number().int().positive().nullable(),
  metadataProfileId: z.number().int().positive().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
})

export type LidarrConnectionRequest = z.infer<typeof LidarrConnectionRequestSchema>
export type LidarrConnectionResult = z.infer<typeof LidarrConnectionResultSchema>
export type LidarrConnectionStatus = z.infer<typeof LidarrConnectionStatusSchema>
