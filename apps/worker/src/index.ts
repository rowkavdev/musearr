import { getConfig } from '@musearr/config'
import { MUSEARR_VERSION } from '@musearr/core'
import {
  createDatabase,
  DAILY_BRIEF_QUEUE,
  getDatabaseStatus,
  getOwnerUserIds,
  getLibrarySyncSources,
  LIBRARY_SYNC_QUEUE,
  PLAYLIST_SYNC_QUEUE,
  PLAYLIST_GENERATION_QUEUE,
  PLAYLIST_ACQUISITION_QUEUE,
  PLAYLIST_PUBLISH_QUEUE,
  PLAYLIST_GENERATION_RECONCILE_QUEUE,
  RECOMMENDATION_RUN_QUEUE,
  RECONCILIATION_QUEUE,
  scheduleLibraryReconciliation,
  scheduleDailyBrief,
  schedulePlaylistGenerationReconcile,
  setPlaylistGenerationStatus,
  startJobQueue,
  type LibrarySyncJob,
  type DailyBriefJob,
  type PlaylistSyncJob,
  type PlaylistGenerationJob,
  type PlaylistAcquisitionJob,
  type PlaylistPublishJob,
  type PlaylistGenerationReconcileJob,
  type RecommendationRunJob,
  type ReconciliationJob,
} from '@musearr/db'
import type { PgBoss } from 'pg-boss'
import { syncPlexLibrary } from './jobs/library-sync.js'
import { syncPlexPlaylists } from './jobs/playlist-sync.js'
import { generateRecommendationRun } from './jobs/recommendation-run.js'
import { generateDailyBrief } from './jobs/daily-brief.js'
import { generatePlaylist } from './jobs/playlist-generation.js'
import { requestPlaylistAcquisitions } from './jobs/playlist-acquisition.js'
import { reconcilePlaylistGenerations } from './jobs/playlist-reconcile.js'
import { publishPlaylistToPlex } from './jobs/playlist-publish.js'
import { sanitisePlaylistFailure } from './jobs/playlist-failures.js'

const config = getConfig()
const database = createDatabase(config.DATABASE_URL)
let jobQueue: PgBoss | null = null

async function start(): Promise<void> {
  const status = await getDatabaseStatus(database)
  if (status !== 'connected') {
    console.error('Musearr worker cannot reach PostgreSQL.')
    process.exitCode = 1
    await database.end({ timeout: 5 })
    return
  }

  jobQueue = await startJobQueue(config.DATABASE_URL, (error) => {
    console.error('Musearr worker queue error.', error)
  })
  await jobQueue.work<LibrarySyncJob>(LIBRARY_SYNC_QUEUE, { batchSize: 1, localConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) {
      const result = await syncPlexLibrary(
        database,
        config.MUSEARR_ENCRYPTION_KEY,
        job.data.librarySectionId,
        job.data.trigger,
      )
      console.info({ jobId: job.id, ...result }, 'Plex library sync completed')
    }
  })
  await jobQueue.work<ReconciliationJob>(
    RECONCILIATION_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const sources = await getLibrarySyncSources(database)
        const jobIds = await Promise.all(
          sources.map((source) =>
            jobQueue!.send(
              LIBRARY_SYNC_QUEUE,
              { librarySectionId: source.librarySectionId, trigger: 'reconciliation' },
              {
                singletonKey: source.librarySectionId,
                singletonSeconds: config.MUSEARR_RECONCILIATION_INTERVAL_MINUTES * 60,
              },
            ),
          ),
        )
        const playlistJobIds = await Promise.all(
          [...new Set(sources.map((source) => source.plexServerId))].map((plexServerId) =>
            jobQueue!.send(
              PLAYLIST_SYNC_QUEUE,
              { plexServerId, trigger: 'reconciliation' },
              {
                singletonKey: plexServerId,
                singletonSeconds: config.MUSEARR_RECONCILIATION_INTERVAL_MINUTES * 60,
              },
            ),
          ),
        )
        console.info(
          { jobId: job.id, trigger: job.data.trigger, libraryCount: sources.length, jobIds, playlistJobIds },
          'Plex reconciliation queued',
        )
      }
    },
  )
  await jobQueue.work<PlaylistSyncJob>(
    PLAYLIST_SYNC_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const result = await syncPlexPlaylists(
          database,
          config.MUSEARR_ENCRYPTION_KEY,
          job.data.plexServerId,
        )
        console.info({ jobId: job.id, ...result }, 'Plex playlist sync completed')
      }
    },
  )
  await jobQueue.work<RecommendationRunJob>(
    RECOMMENDATION_RUN_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const result = await generateRecommendationRun(
          database,
          job.data.userId,
          job.data.kind,
          job.data.limit,
        )
        console.info({ jobId: job.id, ...result }, 'Recommendation run completed')
      }
    },
  )

  await jobQueue.work<DailyBriefJob>(
    DAILY_BRIEF_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const userIds = job.data.userId ? [job.data.userId] : await getOwnerUserIds(database)
        for (const userId of userIds) {
          const result = await generateDailyBrief(database, userId, {
            timezone: config.MUSEARR_TIMEZONE,
            ...(config.MUSEARR_DISCORD_WEBHOOK_URL
              ? { discordWebhookUrl: config.MUSEARR_DISCORD_WEBHOOK_URL }
              : {}),
          })
          console.info(
            { jobId: job.id, userId, created: result.created, delivered: result.delivered },
            'Daily briefing completed',
          )
        }
      }
    },
  )

  await jobQueue.work<PlaylistGenerationJob>(
    PLAYLIST_GENERATION_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          const result = await generatePlaylist(database, config, job.data.generationId)
          if (result.next === 'acquire') {
            await jobQueue!.send(
              PLAYLIST_ACQUISITION_QUEUE,
              { generationId: job.data.generationId },
              { singletonKey: job.data.generationId },
            )
          } else if (result.next === 'publish') {
            await jobQueue!.send(
              PLAYLIST_PUBLISH_QUEUE,
              { generationId: job.data.generationId, trigger: 'manual' },
              { singletonKey: job.data.generationId },
            )
          }
          console.info({ jobId: job.id, generationId: job.data.generationId, ...result }, 'Playlist generation completed')
        } catch (error) {
          await failGeneration(job.data.generationId, error)
          throw error
        }
      }
    },
  )
  await jobQueue.work<PlaylistAcquisitionJob>(
    PLAYLIST_ACQUISITION_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          const result = await requestPlaylistAcquisitions(database, config, job.data.generationId)
          console.info({ jobId: job.id, generationId: job.data.generationId, ...result }, 'Playlist acquisition requested')
        } catch (error) {
          await failGeneration(job.data.generationId, error)
          throw error
        }
      }
    },
  )
  await jobQueue.work<PlaylistPublishJob>(
    PLAYLIST_PUBLISH_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          const result = await publishPlaylistToPlex(database, config, job.data.generationId)
          console.info({ jobId: job.id, generationId: job.data.generationId, ...result }, 'Playlist publish completed')
        } catch (error) {
          await failGeneration(job.data.generationId, error)
          throw error
        }
      }
    },
  )
  await jobQueue.work<PlaylistGenerationReconcileJob>(
    PLAYLIST_GENERATION_RECONCILE_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const result = await reconcilePlaylistGenerations(database, config)
        for (const generationId of result.readyToAcquire) {
          await jobQueue!.send(
            PLAYLIST_ACQUISITION_QUEUE,
            { generationId },
            { singletonKey: generationId },
          )
        }
        for (const generationId of result.readyToPublish) {
          await jobQueue!.send(
            PLAYLIST_PUBLISH_QUEUE,
            { generationId, trigger: 'reconciliation' },
            { singletonKey: generationId },
          )
        }
        console.info({ jobId: job.id, ...result }, 'Playlist generation reconciliation completed')
      }
    },
  )

  await scheduleLibraryReconciliation(jobQueue, config.MUSEARR_RECONCILIATION_INTERVAL_MINUTES)
  await scheduleDailyBrief(jobQueue, config.MUSEARR_DAILY_BRIEF_TIME, config.MUSEARR_TIMEZONE)
  await schedulePlaylistGenerationReconcile(jobQueue)

  console.info(
    `Musearr worker ${MUSEARR_VERSION} is ready for durable Plex sync jobs, ${config.MUSEARR_RECONCILIATION_INTERVAL_MINUTES}-minute reconciliation, and daily briefings at ${config.MUSEARR_DAILY_BRIEF_TIME} ${config.MUSEARR_TIMEZONE}.`,
  )
}

async function failGeneration(generationId: string, error: unknown): Promise<void> {
  const failure = sanitisePlaylistFailure(error)
  try {
    await setPlaylistGenerationStatus(database, generationId, 'failed', failure.summary)
  } catch (updateError) {
    console.error({ generationId, updateError }, 'Could not persist playlist generation failure')
  }
}

async function stop(signal: string): Promise<void> {
  console.info(`Stopping Musearr worker after ${signal}.`)
  await jobQueue?.stop()
  await database.end({ timeout: 5 })
}

process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

void start()
