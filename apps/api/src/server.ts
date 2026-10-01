import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { getConfig, type MusearrConfig } from '@musearr/config'
import {
  CompleteSetupRequestSchema,
  DailyBriefResponseSchema,
  DashboardOverviewSchema,
  CreatePlaylistProposalRequestSchema,
  GeneratePlaylistRequestSchema,
  LidarrConnectionRequestSchema,
  LidarrConnectionResultSchema,
  LidarrConnectionStatusSchema,
  ListeningInsightQuerySchema,
  ListeningInsightSummarySchema,
  LocalAiStatusSchema,
  MusicBrainzStatusSchema,
  PlaylistGenerationAcceptedSchema,
  PlaylistGenerationListResponseSchema,
  PlaylistGenerationResponseSchema,
  PlaylistProposalListResponseSchema,
  PlaylistProposalSchema,
  PlexConnectionRequestSchema,
  PlexPinCreateResponseSchema,
  PlexPinStatusResponseSchema,
  PlexWebhookPayloadSchema,
  QueueLibrarySyncRequestSchema,
  QueueRecommendationRunRequestSchema,
  SyncRunListResponseSchema,
  SyncRunResponseSchema,
  RecommendationQuerySchema,
  type SetupStatus,
  SystemStatusSchema,
  ScrobbleImportRequestSchema,
  ScrobbleImportResponseSchema,
} from '@musearr/contracts'
import { decryptSecret, encryptSecret, hashPassword, MUSEARR_VERSION, verifyPassword } from '@musearr/core'
import {
  createDatabase,
  createPlaylistGeneration,
  createPlaylistProposal,
  DAILY_BRIEF_QUEUE,
  getDashboardOverview,
  getDatabaseStatus,
  getLibrarySyncSources,
  getLatestRecommendations,
  getLatestDailyBrief,
  getListeningInsightSummary,
  getLidarrConnectionStatus,
  getPlaylistGeneration,
  getPlaylistProposal,
  getPlaylistSeedLabel,
  getRecommendationCandidates,
  getSetupStatus,
  getSyncRun,
  listPlaylistGenerations,
  listPlaylistProposals,
  markPlaylistProposalExported,
  listSyncRuns,
  getUserTimezone,
  importScrobbles,
  insertInitialSetup,
  LIBRARY_SYNC_QUEUE,
  PLAYLIST_GENERATION_QUEUE,
  PLAYLIST_SYNC_QUEUE,
  RECOMMENDATION_RUN_QUEUE,
  startJobQueue,
  upsertLidarrConnection,
  type Database,
  getSessionVersion,
  revokeUserSessions,
} from '@musearr/db'
import { generatePlaylistProposalDraft } from '@musearr/intelligence'
import {
  checkPlexPin,
  createPlexPin,
  listPlexServersForToken,
  PlexClient,
  PlexConnectionError,
  plexPinAuthUrl,
  normalisePlexBaseUrl,
} from '@musearr/plex'
import { LidarrClient, LidarrConnectionError, normaliseLidarrBaseUrl } from '@musearr/lidarr'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { createLoginThrottle } from './login-throttle.js'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: 'owner' | 'member'; sv?: number }
    user: { sub: string; role: 'owner' | 'member'; sv?: number }
  }
}

type ServerOptions = {
  config?: MusearrConfig
  database?: Database
  startJobQueue?: boolean
  jobQueue?: Pick<PgBoss, 'send'>
  /** Session revocation store. Defaults to the users table. */
  sessions?: SessionStore
}

type SessionStore = {
  /** Current version for an active user; null when the user is missing or disabled. */
  version(userId: string): Promise<number | null>
  /** Invalidates tokens issued at expectedVersion. A no-op when the stored version has moved on. */
  revoke(userId: string, expectedVersion: number): Promise<void>
}

type ApiJobQueue = Pick<PgBoss, 'send'> & Partial<Pick<PgBoss, 'stop'>>

const SESSION_COOKIE = 'musearr_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

let dummyHash: Promise<string> | undefined
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  return dummyHash
}

function sendProblem(reply: FastifyReply, status: number, code: string, detail: string): FastifyReply {
  return reply.code(status).send({
    type: `https://musearr.local/problems/${code.toLowerCase()}`,
    title: status >= 500 ? 'Musearr could not complete that request.' : 'Musearr needs your attention.',
    status,
    detail,
    code,
  })
}

function sessionSecret(config: MusearrConfig): string {
  if (config.MUSEARR_SESSION_SECRET) {
    return config.MUSEARR_SESSION_SECRET
  }
  if (config.NODE_ENV !== 'production') {
    return 'development-only-session-secret-change-before-production'
  }
  throw new Error('MUSEARR_SESSION_SECRET is required in production.')
}

function configurationForSetup(config: MusearrConfig): string | null {
  return config.MUSEARR_ENCRYPTION_KEY ?? null
}

function sessionCookieOptions(request: FastifyReply['request']) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: request.protocol === 'https',
    path: '/',
  }
}

function setSession(reply: FastifyReply, user: { id: string; role: 'owner' | 'member' }, sessionVersion = 0): void {
  const token = reply.server.jwt.sign({ sub: user.id, role: user.role, sv: sessionVersion }, { expiresIn: SESSION_MAX_AGE_SECONDS })
  reply.setCookie(SESSION_COOKIE, token, {
    ...sessionCookieOptions(reply.request),
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

function isAllowedBrowserMutation(requestOrigin: string | undefined, webOrigin: string): boolean {
  if (!requestOrigin) {
    return true
  }

  try {
    return new URL(requestOrigin).origin === webOrigin
  } catch {
    return false
  }
}

function webhookSecretsMatch(expectedSecret: string | undefined, receivedSecret: unknown): boolean {
  if (!expectedSecret || typeof receivedSecret !== 'string') {
    return false
  }
  const expected = Buffer.from(expectedSecret)
  const received = Buffer.from(receivedSecret)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function isLibraryChangeEvent(event: string): boolean {
  return event.startsWith('library.')
}

async function drainMultipartRequest(request: FastifyRequest): Promise<void> {
  if (!request.isMultipart()) {
    return
  }

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      for await (const chunk of part.file) {
        // Plex may attach a thumbnail. Drain it without retaining media in memory.
        void chunk
      }
    }
  }
}

async function parsePlexWebhookPayload(request: FastifyRequest): Promise<unknown> {
  if (!request.isMultipart()) {
    return request.body
  }

  let payload: string | undefined
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'payload' && typeof part.value === 'string') {
        payload = part.value
      }
      continue
    }
    for await (const chunk of part.file) {
      // Plex may attach a thumbnail. Drain it without retaining media in memory.
      void chunk
    }
  }

  if (!payload) {
    return undefined
  }
  try {
    return JSON.parse(payload) as unknown
  } catch {
    return undefined
  }
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const config = options.config ?? getConfig()
  const database = options.database ?? createDatabase(config.DATABASE_URL)
  const ownsDatabase = !options.database
  const sessions: SessionStore = options.sessions ?? {
    version: (userId) => getSessionVersion(database, userId),
    revoke: (userId, expectedVersion) => revokeUserSessions(database, userId, expectedVersion),
  }
  // PIN status is a credential-bearing capability, owned by its creator's
  // browser. IDs alone are public sequential values, not authorization.
  const setupPins = new Map<number, { owner: string; expiresAt: number }>()
  const pinCookie = 'musearr-setup-pin'
  const pinLifetimeMs = 10 * 60 * 1000
  const prunePins = () => {
    for (const [id, pin] of setupPins) if (pin.expiresAt <= Date.now()) setupPins.delete(id)
  }
  let jobQueue: ApiJobQueue | null = options.jobQueue ?? null
  const app = Fastify({
    trustProxy: config.MUSEARR_TRUST_PROXY,
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: {
        paths: [
          'req.url',
          'req.headers.x-plex-token',
          'req.headers.authorization',
          'req.body.token',
          'req.body.ownerPassword',
        ],
        censor: '[REDACTED]',
      },
    },
  })

  app.register(cors, {
    origin: config.MUSEARR_WEB_ORIGIN,
    credentials: true,
  })
  app.register(cookie)
  app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 64 * 1_024,
      fields: 2,
      fileSize: 1_024 * 1_024,
      files: 1,
      headerPairs: 100,
      parts: 3,
    },
  })
  app.register(jwt, {
    secret: sessionSecret(config),
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    // Sessions issued before tokens carried an exp have no expiry claim. Age them out from iat
    // so they stop working when their 30 day cookie would have lapsed anyway.
    verify: { maxAge: SESSION_MAX_AGE_SECONDS },
    // Every request.jwtVerify() runs this, so logout, disabling a user and deletion revoke
    // existing tokens. Tokens issued before versions existed have no sv and count as 0.
    trusted: async (_request, token) => {
      const current = await sessions.version(token.sub)
      return current !== null && (token.sv ?? 0) === current
    },
  })
  app.register(swagger, {
    openapi: {
      info: { title: 'Musearr API', version: MUSEARR_VERSION },
    },
  })
  app.register(swaggerUi, { routePrefix: '/documentation' })

  app.addHook('onRequest', async (request, reply) => {
    if (isSafeMethod(request.method)) {
      return
    }
    if (!isAllowedBrowserMutation(request.headers.origin, config.MUSEARR_WEB_ORIGIN)) {
      sendProblem(reply, 403, 'CROSS_ORIGIN_REQUEST', 'Use Musearr from its configured web address.')
      return
    }
  })

  app.addHook('onReady', async () => {
    if (options.startJobQueue !== false && !jobQueue) {
      jobQueue = await startJobQueue(config.DATABASE_URL, (error) => app.log.error(error, 'Job queue error'))
    }
  })

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error)
    if (typeof error === 'object' && error !== null && 'validation' in error) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'One or more fields need to be corrected.')
    }
    return sendProblem(
      reply,
      500,
      'INTERNAL_ERROR',
      'Try again shortly. The detailed error is available only in local logs.',
    )
  })

  app.get('/api/v1/system/health', async (_request, reply) => {
    const databaseStatus = await getDatabaseStatus(database)
    const status = databaseStatus === 'connected' ? 'healthy' : 'degraded'
    const payload = SystemStatusSchema.parse({
      status,
      version: MUSEARR_VERSION,
      database: databaseStatus,
      checkedAt: new Date().toISOString(),
    })
    return reply.code(status === 'healthy' ? 200 : 503).send(payload)
  })

  app.get('/api/v1/setup/status', async (_request, reply) => {
    const databaseStatus = await getDatabaseStatus(database)
    if (databaseStatus === 'unavailable') {
      return sendProblem(reply, 503, 'DATABASE_UNAVAILABLE', 'Musearr cannot reach its local database.')
    }

    const status = await getSetupStatus(database)
    const payload: SetupStatus = {
      phase: status.configured ? 'configured' : 'unconfigured',
      plexServer: status.plexServer,
    }
    return reply.send(payload)
  })

  app.post('/api/v1/setup/test-plex', async (request, reply) => {
    const existing = await getSetupStatus(database)
    if (existing.configured) {
      return sendProblem(
        reply,
        409,
        'INSTANCE_ALREADY_CONFIGURED',
        'This Musearr instance has already been configured.',
      )
    }

    const parsed = PlexConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Enter a Plex server URL and token.')
    }

    try {
      const result = await new PlexClient(parsed.data.baseUrl, parsed.data.token).testConnection()
      return reply.send(result)
    } catch (error) {
      if (error instanceof PlexConnectionError) {
        return sendProblem(reply, error.code === 'UNAUTHENTICATED' ? 401 : 422, error.code, error.message)
      }
      throw error
    }
  })

  app.get('/api/v1/playlists/proposals', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view playlist proposals.')
    }

    const proposals = await listPlaylistProposals(database, request.user.sub)
    return reply.send(PlaylistProposalListResponseSchema.parse({ proposals }))
  })

  app.post('/api/v1/playlists/proposals', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to generate playlist proposals.')
    }

    const parsed = CreatePlaylistProposalRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Provide valid proposal options.')
    }

    const candidates = await getRecommendationCandidates(database, request.user.sub)
    if (candidates.length === 0) {
      return sendProblem(reply, 422, 'NO_CANDIDATES', 'Library has no track candidates for playlist generation.')
    }

    const proposalOptions: { title?: string; limit: number } = { limit: parsed.data.limit }
    if (parsed.data.title) {
      proposalOptions.title = parsed.data.title
    }
    const draft = generatePlaylistProposalDraft(candidates, parsed.data.kind, proposalOptions)

    const proposal = await createPlaylistProposal(database, {
      userId: request.user.sub,
      title: draft.title,
      kind: draft.kind,
      algorithmVersion: draft.algorithmVersion,
      trackIds: draft.trackIds,
    })

    return reply.code(201).send(PlaylistProposalSchema.parse(proposal))
  })

  app.post('/api/v1/playlists/proposals/:id/export-to-plex', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to export playlist proposal to Plex.')
    }

    const rawId = (request.params as { id?: unknown }).id
    const id = typeof rawId === 'string' ? rawId : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Provide a valid playlist proposal id.')
    }

    return database.begin(async (transaction) => {
      // Serialize concurrent exports across API instances before reading status.
      await transaction`
        SELECT id FROM playlist_proposals
        WHERE id = ${id}::uuid AND user_id = ${request.user.sub}::uuid
        FOR UPDATE
      `
      const proposal = await getPlaylistProposal(transaction as unknown as Database, id, request.user.sub)
      if (!proposal) {
        return sendProblem(reply, 404, 'PROPOSAL_NOT_FOUND', 'Playlist proposal not found.')
      }

      if (proposal.status === 'exported') {
        return reply.send(PlaylistProposalSchema.parse(proposal))
      }
      if (proposal.status !== 'draft') {
        return sendProblem(reply, 409, 'PROPOSAL_NOT_DRAFT', 'Only draft proposals can be exported.')
      }

      const sources = await getLibrarySyncSources(transaction as unknown as Database)
      const source = sources[0]
      if (!source) {
        return sendProblem(reply, 400, 'NO_PLEX_SERVER', 'No Plex server configured for playlist export.')
      }

      const encryptionKey = configurationForSetup(config)
      if (!encryptionKey) {
        return sendProblem(reply, 503, 'MISSING_ENCRYPTION_KEY', 'Encryption key is missing.')
      }

      try {
        const plexToken = decryptSecret(source.tokenCiphertext, encryptionKey)
        const client = new PlexClient(source.baseUrl, plexToken)
        const trackRatingKeys = proposal.items.map((item) => item.plexRatingKey)

        const createdPlexPlaylist = await client.createPlaylist(proposal.title, trackRatingKeys)
        await markPlaylistProposalExported(
          transaction as unknown as Database,
          proposal.id,
          request.user.sub,
          createdPlexPlaylist.plexRatingKey,
        )

        const updatedProposal = await getPlaylistProposal(transaction as unknown as Database, proposal.id, request.user.sub)
        return reply.send(PlaylistProposalSchema.parse(updatedProposal))
      } catch (error) {
        if (error instanceof PlexConnectionError) {
          return sendProblem(reply, 502, error.code, error.message)
        }
        throw error
      }
    })
  })

  app.post('/api/v1/setup/plex-pin', async (request, reply) => {
    const existing = await getSetupStatus(database)
    if (existing.configured) {
      return sendProblem(
        reply,
        409,
        'INSTANCE_ALREADY_CONFIGURED',
        'This Musearr instance has already been configured.',
      )
    }

    try {
      prunePins()
      if (setupPins.size >= 1000) return sendProblem(reply, 429, 'TOO_MANY_PINS', 'Too many pending Plex sign-ins. Try again later.')
      const pin = await createPlexPin()
      const owner = randomBytes(32).toString('hex')
      setupPins.set(pin.id, { owner, expiresAt: Date.now() + pinLifetimeMs })
      reply.setCookie(pinCookie, owner, {
        httpOnly: true, sameSite: 'strict', secure: request.protocol === 'https',
        path: '/api/v1/setup/plex-pin', maxAge: pinLifetimeMs / 1000,
      })
      return reply.send(
        PlexPinCreateResponseSchema.parse({
          id: pin.id,
          code: pin.code,
          authUrl: plexPinAuthUrl(pin.code),
        }),
      )
    } catch (error) {
      if (error instanceof PlexConnectionError) {
        return sendProblem(reply, 502, error.code, 'Musearr could not start Plex sign-in. Try again.')
      }
      throw error
    }
  })

  app.get('/api/v1/setup/plex-pin/:id', async (request, reply) => {
    const existing = await getSetupStatus(database)
    if (existing.configured) {
      return sendProblem(
        reply,
        409,
        'INSTANCE_ALREADY_CONFIGURED',
        'This Musearr instance has already been configured.',
      )
    }

    const rawId = (request.params as { id?: unknown }).id
    const id = typeof rawId === 'string' ? Number(rawId) : NaN
    if (!Number.isInteger(id) || id <= 0) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Provide a valid Plex sign-in id.')
    }

    prunePins()
    const issued = setupPins.get(id)
    const owner = request.cookies[pinCookie]
    if (!issued || !owner || !webhookSecretsMatch(issued.owner, owner)) {
      return sendProblem(reply, 404, 'PIN_NOT_FOUND', 'Start Plex sign-in in this browser first.')
    }

    try {
      const { authToken } = await checkPlexPin(id)
      if (!authToken) {
        return reply.send(PlexPinStatusResponseSchema.parse({ authToken: null, servers: [] }))
      }
      const servers = await listPlexServersForToken(authToken)
      setupPins.delete(id)
      reply.clearCookie(pinCookie, { path: '/api/v1/setup/plex-pin' })
      return reply.send(PlexPinStatusResponseSchema.parse({ authToken, servers }))
    } catch (error) {
      if (error instanceof PlexConnectionError) {
        return sendProblem(reply, 502, error.code, 'Musearr could not check Plex sign-in status. Try again.')
      }
      throw error
    }
  })

  app.post('/api/v1/webhooks/plex', async (request, reply) => {
    const query = request.query as { secret?: unknown }
    if (!webhookSecretsMatch(config.MUSEARR_PLEX_WEBHOOK_SECRET, query.secret)) {
      await drainMultipartRequest(request)
      return reply.code(404).send()
    }

    const parsed = PlexWebhookPayloadSchema.safeParse(await parsePlexWebhookPayload(request))
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_WEBHOOK', 'Musearr could not read the Plex webhook payload.')
    }
    if (!isLibraryChangeEvent(parsed.data.event)) {
      return reply.code(204).send()
    }

    const plexSectionId = parsed.data.Metadata?.librarySectionID
    const machineIdentifier = parsed.data.Server?.uuid
    if (!plexSectionId || !machineIdentifier) {
      return reply.code(204).send()
    }

    const sources = await getLibrarySyncSources(database)
    const source = sources.find(
      (candidate) => candidate.machineIdentifier === machineIdentifier && candidate.plexSectionId === plexSectionId,
    )
    if (!source) {
      return reply.code(204).send()
    }

    if (!jobQueue) {
      return sendProblem(reply, 503, 'QUEUE_UNAVAILABLE', 'Musearr is still preparing its local job queue.')
    }

    const jobId = await jobQueue.send(
      LIBRARY_SYNC_QUEUE,
      { librarySectionId: source.librarySectionId, trigger: 'webhook' },
      { singletonKey: source.librarySectionId, singletonSeconds: 60 },
    )
    request.log.info(
      {
        event: parsed.data.event,
        librarySectionId: source.librarySectionId,
        jobId,
      },
      'Queued Plex webhook refresh',
    )
    return reply.code(204).send()
  })

  app.post('/api/v1/setup/complete', async (request, reply) => {
    const parsed = CompleteSetupRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(
        reply,
        400,
        'INVALID_REQUEST',
        'Review the Plex connection, local owner, and selected music libraries.',
      )
    }

    const encryptionKey = configurationForSetup(config)
    if (!encryptionKey) {
      return sendProblem(
        reply,
        503,
        'MISSING_ENCRYPTION_KEY',
        'Set MUSEARR_ENCRYPTION_KEY before saving a Plex connection.',
      )
    }

    const existing = await getSetupStatus(database)
    if (existing.configured) {
      return sendProblem(
        reply,
        409,
        'INSTANCE_ALREADY_CONFIGURED',
        'This Musearr instance has already been configured.',
      )
    }

    try {
      const connection = await new PlexClient(parsed.data.baseUrl, parsed.data.token).testConnection()
      const selectedIds = new Set(parsed.data.selectedLibraryIds)
      const selectedLibraries = connection.musicLibraries.filter((library) => selectedIds.has(library.id))
      if (selectedLibraries.length !== selectedIds.size) {
        return sendProblem(reply, 400, 'INVALID_LIBRARY_SELECTION', 'Select only music libraries returned by Plex.')
      }

      const result = await insertInitialSetup(database, {
        ownerUsername: parsed.data.ownerUsername,
        passwordHash: await hashPassword(parsed.data.ownerPassword),
        machineIdentifier: connection.machineIdentifier,
        serverName: connection.serverName,
        baseUrl: normalisePlexBaseUrl(parsed.data.baseUrl),
        tokenCiphertext: encryptSecret(parsed.data.token, encryptionKey),
        selectedLibraries: selectedLibraries.map((library) => ({
          plexSectionId: library.id,
          title: library.title,
        })),
      })
      const readyJobQueue = jobQueue
      let initialJobIds: Array<string | null> = []
      if (readyJobQueue) {
        try {
          initialJobIds = await Promise.all([
            ...(await getLibrarySyncSources(database)).map((source) =>
              readyJobQueue.send(LIBRARY_SYNC_QUEUE, {
                librarySectionId: source.librarySectionId,
                trigger: 'initial-setup',
              }),
            ),
            readyJobQueue.send(PLAYLIST_SYNC_QUEUE, {
              plexServerId: result.server.id,
              trigger: 'initial-setup',
            }),
          ])
        } catch (queueError) {
          app.log.error(queueError, 'Initial Plex sync could not be queued after setup')
        }
      }
      setSession(reply, result.user)
      return reply.code(201).send({
        user: { username: result.user.username, role: result.user.role },
        plexServer: {
          name: result.server.name,
          machineIdentifier: result.server.machineIdentifier,
        },
        initialJobIds,
      })
    } catch (error) {
      if (error instanceof PlexConnectionError) {
        return sendProblem(reply, error.code === 'UNAUTHENTICATED' ? 401 : 422, error.code, error.message)
      }
      if (error instanceof Error && error.message === 'INSTANCE_ALREADY_CONFIGURED') {
        return sendProblem(
          reply,
          409,
          'INSTANCE_ALREADY_CONFIGURED',
          'This Musearr instance has already been configured.',
        )
      }
      throw error
    }
  })

  const loginThrottle = createLoginThrottle()

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown }
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Enter your local owner credentials.')
    }
    // Setup caps these at 64 and 1024, so no real account is longer. Stops huge values becoming throttle keys.
    if (body.username.length > 64 || body.password.length > 1024) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'The username or password is too long.')
    }

    const throttleAddress = request.ip
    const throttleUsername = body.username.trim().toLowerCase()
    const retryAfter = loginThrottle.reserve(throttleAddress, throttleUsername)
    if (retryAfter > 0) {
      reply.header('Retry-After', String(retryAfter))
      return sendProblem(reply, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again in a few minutes.')
    }

    const users = await database<Array<{ id: string; password_hash: string; role: 'owner' | 'member'; session_version: number }>>`
      SELECT id, password_hash, role, session_version FROM users
      WHERE username = ${body.username.trim()}
      AND disabled_at IS NULL
      LIMIT 1
    `
    const user = users[0]
    // Check against a dummy hash when there is no such user, so both cases cost one scrypt run.
    const passwordHash = user?.password_hash ?? (await dummyPasswordHash())
    const passwordOk = await verifyPassword(body.password, passwordHash)
    if (!user || !passwordOk) {
      return sendProblem(reply, 401, 'INVALID_CREDENTIALS', 'The username or password is not correct.')
    }

    loginThrottle.recordSuccess(throttleAddress, throttleUsername)
    setSession(reply, { id: user.id, role: user.role }, user.session_version)
    return reply.code(204).send()
  })

  app.get('/api/v1/auth/me', async (request, reply) => {
    try {
      await request.jwtVerify()
      return reply.send({ user: request.user })
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to continue.')
    }
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    // Revoke before clearing the cookie so a copied token stops working. A missing or
    // invalid token has nothing to revoke; the cookie is cleared either way.
    // Check the signature only. request.jwtVerify() also asks the database for the user's
    // session version, and an outage there would be read as "not signed in" and skip revocation.
    let session: { sub: string; sv: number } | null = null
    const token = request.cookies[SESSION_COOKIE]
    if (token) {
      try {
        const verified = app.jwt.verify<{ sub: string; sv?: number }>(token)
        session = { sub: verified.sub, sv: verified.sv ?? 0 }
      } catch {
        // Missing or invalid tokens have nothing to revoke.
      }
    }
    // A storage failure must not look like successful logout while copied tokens
    // remain valid. Let the server return an error and keep the cookie for retry.
    // Conditional on the token's own version: a stale or revoked token cannot sign the user out again.
    if (session !== null) await sessions.revoke(session.sub, session.sv)
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(request))
    return reply.code(204).send()
  })

  app.get('/api/v1/sync-runs', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view sync activity.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can view sync activity.')
    }
    return reply.send(SyncRunListResponseSchema.parse({ runs: await listSyncRuns(database) }))
  })

  app.get('/api/v1/sync-runs/:id', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view sync activity.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can view sync activity.')
    }
    const id = typeof (request.params as { id?: unknown }).id === 'string' ? (request.params as { id: string }).id : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Choose a valid sync run.')
    }
    const run = await getSyncRun(database, id)
    if (!run) return sendProblem(reply, 404, 'SYNC_RUN_NOT_FOUND', 'No sync run matched this request.')
    return reply.send(SyncRunResponseSchema.parse({ run }))
  })

  app.post('/api/v1/sync', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to start a library sync.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can start a library sync.')
    }

    const parsed = QueueLibrarySyncRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Choose a valid music library to sync.')
    }
    const readyJobQueue = jobQueue
    if (!readyJobQueue) {
      return sendProblem(reply, 503, 'QUEUE_UNAVAILABLE', 'Musearr is still preparing its local job queue.')
    }

    const sources = await getLibrarySyncSources(database, parsed.data.librarySectionId)
    if (sources.length === 0) {
      return sendProblem(reply, 404, 'LIBRARY_NOT_FOUND', 'No selected Plex music library matched this request.')
    }

    const jobs = await Promise.all(
      sources.map(async (source) => ({
        librarySectionId: source.librarySectionId,
        jobId: await readyJobQueue.send(
          LIBRARY_SYNC_QUEUE,
          { librarySectionId: source.librarySectionId, trigger: 'manual' },
          { singletonKey: source.librarySectionId, singletonSeconds: 60 },
        ),
      })),
    )
    return reply.code(202).send({ jobs })
  })

  app.post('/api/v1/recommendations/runs', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to generate recommendations.')
    }

    const parsed = QueueRecommendationRunRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Choose a valid recommendation type and length.')
    }
    const readyJobQueue = jobQueue
    if (!readyJobQueue) {
      return sendProblem(reply, 503, 'QUEUE_UNAVAILABLE', 'Musearr is still preparing its local job queue.')
    }

    const jobId = await readyJobQueue.send(
      RECOMMENDATION_RUN_QUEUE,
      {
        userId: request.user.sub,
        kind: parsed.data.kind,
        limit: parsed.data.limit,
        trigger: 'manual',
      },
      {
        singletonKey: `${request.user.sub}:${parsed.data.kind}`,
        singletonSeconds: 30,
      },
    )
    return reply.code(202).send({ jobId, kind: parsed.data.kind })
  })

  app.get('/api/v1/recommendations', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view recommendations.')
    }

    const parsed = RecommendationQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Choose a valid recommendation type.')
    }
    const recommendations = await getLatestRecommendations(database, request.user.sub, parsed.data.kind)
    return reply.send({ recommendations })
  })

  app.post('/api/v1/daily-briefs/generate', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to generate a daily briefing.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can generate a daily briefing.')
    }
    if (!jobQueue) {
      return sendProblem(reply, 503, 'QUEUE_UNAVAILABLE', 'Musearr is still preparing its local job queue.')
    }

    const jobId = await jobQueue.send(
      DAILY_BRIEF_QUEUE,
      { trigger: 'manual', userId: request.user.sub },
      { singletonKey: request.user.sub, singletonSeconds: 60 },
    )
    return reply.code(202).send({ jobId })
  })

  app.get('/api/v1/daily-briefs/latest', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view your daily briefing.')
    }

    return reply.send(
      DailyBriefResponseSchema.parse({
        brief: await getLatestDailyBrief(database, request.user.sub),
      }),
    )
  })

  app.get('/api/v1/dashboard', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view your music dashboard.')
    }

    const overview = await getDashboardOverview(database, request.user.sub)
    return reply.send(DashboardOverviewSchema.parse(overview))
  })

  app.get('/api/v1/insights/listening', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view your listening insights.')
    }

    const parsed = ListeningInsightQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Choose a period between 7 and 90 days.')
    }
    const timezone = await getUserTimezone(database, request.user.sub)
    const insight = await getListeningInsightSummary(database, request.user.sub, timezone, parsed.data.days)
    return reply.send(ListeningInsightSummarySchema.parse(insight))
  })

  app.post('/api/v1/playlists/generate', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to generate a playlist.')
    }

    const parsed = GeneratePlaylistRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Choose a seed track and a playlist length.')
    }
    const readyJobQueue = jobQueue
    if (!readyJobQueue) {
      return sendProblem(reply, 503, 'QUEUE_UNAVAILABLE', 'Musearr is still preparing its local job queue.')
    }

    const seedLabel = await getPlaylistSeedLabel(database, parsed.data.seedTrackId)
    if (!seedLabel) {
      return sendProblem(reply, 404, 'SEED_TRACK_NOT_FOUND', 'That track is not in the local library mirror.')
    }

    const generationId = await createPlaylistGeneration(database, {
      userId: request.user.sub,
      seedTrackId: parsed.data.seedTrackId,
      seedLabel,
      name: parsed.data.name?.trim() || `Like ${seedLabel}`,
      algorithmVersion: 'pending',
      targetSize: parsed.data.targetSize,
      acquireMissing: parsed.data.acquireMissing,
      publishToPlex: parsed.data.publishToPlex,
    })
    await readyJobQueue.send(
      PLAYLIST_GENERATION_QUEUE,
      { generationId, trigger: 'manual' },
      { singletonKey: generationId },
    )
    return reply
      .code(202)
      .send(PlaylistGenerationAcceptedSchema.parse({ generationId, status: 'generating' }))
  })

  app.get('/api/v1/playlists/generations', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view your playlists.')
    }
    return reply.send(
      PlaylistGenerationListResponseSchema.parse({
        generations: await listPlaylistGenerations(database, request.user.sub),
      }),
    )
  })

  app.get('/api/v1/playlists/generations/:id', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view your playlists.')
    }
    const id = typeof (request.params as { id?: unknown }).id === 'string' ? (request.params as { id: string }).id : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Choose a valid playlist.')
    }
    const generation = await getPlaylistGeneration(database, request.user.sub, id)
    if (!generation) {
      return sendProblem(reply, 404, 'PLAYLIST_NOT_FOUND', 'No generated playlist matched this request.')
    }
    return reply.send(PlaylistGenerationResponseSchema.parse({ generation }))
  })

  app.post('/api/v1/settings/lidarr/test', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to test the Lidarr connection.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can manage integrations.')
    }

    const parsed = LidarrConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Enter a Lidarr URL and API key.')
    }

    try {
      const result = await new LidarrClient(parsed.data.baseUrl, parsed.data.apiKey).testConnection()
      return reply.send(LidarrConnectionResultSchema.parse(result))
    } catch (error) {
      if (error instanceof LidarrConnectionError) {
        return sendProblem(reply, error.code === 'UNAUTHENTICATED' ? 401 : 422, error.code, error.message)
      }
      throw error
    }
  })

  app.post('/api/v1/settings/lidarr', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to save the Lidarr connection.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can manage integrations.')
    }

    const parsed = LidarrConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Enter a Lidarr URL and API key.')
    }
    const encryptionKey = configurationForSetup(config)
    if (!encryptionKey) {
      return sendProblem(
        reply,
        503,
        'MISSING_ENCRYPTION_KEY',
        'Set MUSEARR_ENCRYPTION_KEY before saving a Lidarr connection.',
      )
    }

    try {
      const result = await new LidarrClient(parsed.data.baseUrl, parsed.data.apiKey).testConnection()
      await upsertLidarrConnection(database, {
        baseUrl: normaliseLidarrBaseUrl(parsed.data.baseUrl),
        apiKeyCiphertext: encryptSecret(parsed.data.apiKey, encryptionKey),
        instanceName: result.instanceName,
        version: result.version,
        rootFolderPath:
          parsed.data.rootFolderPath ?? result.rootFolders[0]?.path ?? null,
        qualityProfileId:
          parsed.data.qualityProfileId ?? result.qualityProfiles[0]?.id ?? null,
        metadataProfileId:
          parsed.data.metadataProfileId ?? result.metadataProfiles[0]?.id ?? null,
      })
      return reply.send(LidarrConnectionStatusSchema.parse(await getLidarrConnectionStatus(database)))
    } catch (error) {
      if (error instanceof LidarrConnectionError) {
        return sendProblem(reply, error.code === 'UNAUTHENTICATED' ? 401 : 422, error.code, error.message)
      }
      throw error
    }
  })

  app.get('/api/v1/settings/lidarr', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view integration settings.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can manage integrations.')
    }
    return reply.send(LidarrConnectionStatusSchema.parse(await getLidarrConnectionStatus(database)))
  })

  app.get('/api/v1/settings/local-ai', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view integration settings.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can manage integrations.')
    }
    return reply.send(
      LocalAiStatusSchema.parse({
        enabled: config.MUSEARR_LOCAL_AI_ENABLED,
        provider: config.MUSEARR_LOCAL_AI_PROVIDER,
        model: config.MUSEARR_LOCAL_AI_MODEL ?? null,
        baseUrl: config.MUSEARR_LOCAL_AI_BASE_URL ?? null,
        reachable: null,
      }),
    )
  })

  app.get('/api/v1/settings/musicbrainz', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to view integration settings.')
    }
    if (request.user.role !== 'owner') {
      return sendProblem(reply, 403, 'FORBIDDEN', 'Only the local owner can manage integrations.')
    }
    return reply.send(
      MusicBrainzStatusSchema.parse({
        enabled: config.MUSEARR_MUSICBRAINZ_ENABLED && Boolean(config.MUSEARR_MUSICBRAINZ_CONTACT),
        contactConfigured: Boolean(config.MUSEARR_MUSICBRAINZ_CONTACT),
        musicBrainzBaseUrl: config.MUSEARR_MUSICBRAINZ_BASE_URL ?? null,
        listenBrainzBaseUrl: config.MUSEARR_LISTENBRAINZ_BASE_URL ?? null,
      }),
    )
  })

  app.post('/api/v1/imports/scrobbles', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return sendProblem(reply, 401, 'UNAUTHENTICATED', 'Sign in to import scrobbles.')
    }

    const parsed = ScrobbleImportRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(reply, 400, 'INVALID_REQUEST', 'Provide a valid list of scrobbles to import.')
    }

    try {
      const scrobbles = parsed.data.scrobbles.map((s) => {
        const item: { artistName: string; trackTitle: string; occurredAt: string; albumTitle?: string } = {
          artistName: s.artistName,
          trackTitle: s.trackTitle,
          occurredAt: s.occurredAt,
        }
        if (s.albumTitle !== undefined) {
          item.albumTitle = s.albumTitle
        }
        return item
      })
      const result = await importScrobbles(database, request.user.sub, scrobbles)
      return reply.code(200).send(ScrobbleImportResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'NO_PLEX_SERVER_CONFIGURED') {
        return sendProblem(reply, 400, 'NO_PLEX_SERVER', 'Configure a Plex server before importing scrobbles.')
      }
      throw error
    }
  })

  if (ownsDatabase) {
    app.addHook('onClose', async () => {
      await jobQueue?.stop?.()
      await database.end({ timeout: 5 })
    })
  }

  return app
}

