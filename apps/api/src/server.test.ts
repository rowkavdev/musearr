import { getConfig } from '@musearr/config'
import type { Database } from '@musearr/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret, hashPassword } from '@musearr/core'
import { PlexClient } from '@musearr/plex'
import { buildServer } from './server.js'

const apps: ReturnType<typeof buildServer>[] = []

function createServer(
  options: {
    database?: Database
    // vitest 4 types vi.fn() as a mock of any function or class, so cast it
    // to the queue's send() here instead of in every test.
    jobQueue?: { send: ReturnType<typeof vi.fn> }
    webhookSecret?: string
    encryptionKey?: string
    sessions?: { version(userId: string): Promise<number | null>; revoke(userId: string, expectedVersion: number): Promise<void> }
  } = {},
) {
  const app = buildServer({
    config: getConfig({
      NODE_ENV: 'test',
      MUSEARR_ENCRYPTION_KEY: options.encryptionKey,
      DATABASE_URL: 'postgresql://musearr:musearr@localhost:5432/musearr',
      MUSEARR_WEB_ORIGIN: 'https://musearr.test',
      MUSEARR_TRUST_PROXY: 'true',
      MUSEARR_SESSION_SECRET: 'a-session-secret-that-is-at-least-thirty-two-characters',
      MUSEARR_PLEX_WEBHOOK_SECRET: options.webhookSecret,
    }),
    database: options.database ?? ({} as Database),
    startJobQueue: false,
    // Tests sign tokens for made-up users, so the default store accepts every user at version 0.
    sessions: options.sessions ?? { version: async () => 0, revoke: async () => undefined },
    ...(options.jobQueue ? { jobQueue: options.jobQueue as unknown as NonNullable<NonNullable<Parameters<typeof buildServer>[0]>['jobQueue']> } : {}),
  })
  apps.push(app)
  return app
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('Plex webhooks', () => {
  it('does not expose the webhook receiver until a secret is configured', async () => {
    const boundary = 'musearr-disabled-webhook-test'
    const response = await createServer().inject({
      method: 'POST',
      url: '/api/v1/webhooks/plex',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="payload"',
        '',
        JSON.stringify({ event: 'library.new' }),
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    })

    expect(response.statusCode).toBe(404)
  }, 15_000)

  it('queues a matching selected music library from a multipart Plex event', async () => {
    const sourceDatabase = (async () => [
      {
        plex_server_id: 'server-id',
        machine_identifier: 'server-machine',
        library_section_id: '9ad3649a-a78f-4aea-99dc-473c7c1c5501',
        plex_section_id: '7',
        server_name: 'Plex',
        base_url: 'http://plex.local:32400',
        token_ciphertext: 'ciphertext',
        owner_user_id: 'owner-id',
      },
    ]) as unknown as Database
    const send = vi.fn().mockResolvedValue('job-1')
    const secret = 'a-webhook-secret-that-is-at-least-thirty-two-characters'
    const boundary = 'musearr-webhook-test'
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="payload"',
      '',
      JSON.stringify({
        event: 'library.new',
        Server: { uuid: 'server-machine' },
        Metadata: { librarySectionID: 7, librarySectionType: 'artist' },
      }),
      `--${boundary}--`,
      '',
    ].join('\r\n')

    const response = await createServer({
      database: sourceDatabase,
      jobQueue: { send },
      webhookSecret: secret,
    }).inject({
      method: 'POST',
      url: `/api/v1/webhooks/plex?secret=${secret}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })

    expect(response.statusCode).toBe(204)
    expect(send).toHaveBeenCalledWith(
      'library.sync',
      {
        librarySectionId: '9ad3649a-a78f-4aea-99dc-473c7c1c5501',
        trigger: 'webhook',
      },
      {
        singletonKey: '9ad3649a-a78f-4aea-99dc-473c7c1c5501',
        singletonSeconds: 60,
      },
    )
  })
})

describe('browser mutation protections', () => {
  it('rejects a state-changing request from a different browser origin', async () => {
    const response = await createServer().inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: 'https://untrusted.example' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'CROSS_ORIGIN_REQUEST' })
  })

  it('accepts the configured origin and clears a proxy-secure session cookie', async () => {
    const response = await createServer().inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: 'https://musearr.test',
        'x-forwarded-proto': 'https',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.headers['set-cookie']).toContain('Secure')
    expect(response.headers['set-cookie']).toContain('SameSite=Lax')
  })
})

describe('dashboard', () => {
  it('requires a local session before exposing listening data', async () => {
    const response = await createServer().inject({
      method: 'GET',
      url: '/api/v1/dashboard',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('requires a local session before exposing a daily briefing', async () => {
    const response = await createServer().inject({
      method: 'GET',
      url: '/api/v1/daily-briefs/latest',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('requires a local session before listing sync runs', async () => {
    const response = await createServer().inject({ method: 'GET', url: '/api/v1/sync-runs' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('requires a local session before exposing a sync run', async () => {
    const response = await createServer().inject({
      method: 'GET',
      url: '/api/v1/sync-runs/9ad3649a-a78f-4aea-99dc-473c7c1c5501',
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('requires a local session before exposing listening insights', async () => {
    const response = await createServer().inject({
      method: 'GET',
      url: '/api/v1/insights/listening',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('requires a local session before importing scrobbles', async () => {
    const response = await createServer().inject({
      method: 'POST',
      url: '/api/v1/imports/scrobbles',
      payload: { scrobbles: [] },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('requires a local session before managing playlist proposals', async () => {
    const getRes = await createServer().inject({
      method: 'GET',
      url: '/api/v1/playlists/proposals',
    })
    expect(getRes.statusCode).toBe(401)

    const postRes = await createServer().inject({
      method: 'POST',
      url: '/api/v1/playlists/proposals',
      payload: {},
    })
    expect(postRes.statusCode).toBe(401)

    const exportRes = await createServer().inject({
      method: 'POST',
      url: '/api/v1/playlists/proposals/9ad3649a-a78f-4aea-99dc-473c7c1c5501/export-to-plex',
    })
    expect(exportRes.statusCode).toBe(401)
  })
})


describe('sync run observability', () => {
  const runId = '9ad3649a-a78f-4aea-99dc-473c7c1c5501'
  const syncRunRow = {
    id: runId,
    library_section_id: '2d95d6bc-6d55-43ab-a2ea-217a954a92a1',
    library_title: 'Music',
    kind: 'manual-library-import',
    status: 'failed' as const,
    counts: { importedTracks: 4, skippedTracks: 2 },
    error_summary: 'authentication: Plex authentication was rejected.',
    started_at: '2026-08-06T07:00:00.000Z',
    finished_at: '2026-08-06T07:01:00.000Z',
    created_at: '2026-08-06T06:59:00.000Z',
  }

  async function sessionHeaders(app: ReturnType<typeof buildServer>, role: 'owner' | 'member' = 'owner') {
    await app.ready()
    return { cookie: `musearr_session=${app.jwt.sign({ sub: `${role}-id`, role })}` }
  }

  it('requires an authenticated owner to list sync runs', async () => {
    const app = createServer()
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/sync-runs' })
    const nonOwner = await app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs',
      headers: await sessionHeaders(app, 'member'),
    })

    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(nonOwner.statusCode).toBe(403)
    expect(nonOwner.json()).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('returns validated safe sync run values to the local owner', async () => {
    const database = (async () => [syncRunRow]) as unknown as Database
    const app = createServer({ database })
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs',
      headers: await sessionHeaders(app),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      runs: [{
        id: runId,
        librarySectionId: '2d95d6bc-6d55-43ab-a2ea-217a954a92a1',
        libraryTitle: 'Music',
        kind: 'manual-library-import',
        status: 'failed',
        counts: { importedTracks: 4, skippedTracks: 2 },
        startedAt: '2026-08-06T07:00:00.000Z',
        finishedAt: '2026-08-06T07:01:00.000Z',
        createdAt: '2026-08-06T06:59:00.000Z',
        failure: { classification: 'authentication', summary: 'Plex authentication was rejected.' },
      }],
    })
  })

  it('validates ids and returns found or hidden missing records', async () => {
    const database = vi
      .fn()
      .mockResolvedValueOnce([syncRunRow])
      .mockResolvedValueOnce([]) as unknown as Database
    const app = createServer({ database })
    const headers = await sessionHeaders(app)

    const invalid = await app.inject({ method: 'GET', url: '/api/v1/sync-runs/not-a-uuid', headers })
    const found = await app.inject({ method: 'GET', url: `/api/v1/sync-runs/${runId}`, headers })
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs/1394ed5a-2f78-492f-b0d1-5f37bc4218bc',
      headers,
    })

    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(found.statusCode).toBe(200)
    expect(found.json()).toMatchObject({ run: { id: runId, failure: { classification: 'authentication' } } })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'SYNC_RUN_NOT_FOUND' })
  })
})

describe('Setup connection testing security', () => {
  it('blocks connection testing if already configured', async () => {
    // getSetupStatus returns user IDs/configured status
    const database = (async () => [{ id: 'some-user-id' }]) as unknown as Database
    const app = createServer({ database })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/test-plex',
      payload: {
        baseUrl: 'http://localhost:32400',
        token: 'some-dummy-token-that-is-long-enough',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      code: 'INSTANCE_ALREADY_CONFIGURED',
      detail: 'This Musearr instance has already been configured.',
    })
  })

  it('allows connection testing if unconfigured', async () => {
    const database = (async () => []) as unknown as Database
    const app = createServer({ database })

    // Stub PlexClient testConnection
    const testConnectionSpy = vi.spyOn(
      (await import('@musearr/plex')).PlexClient.prototype,
      'testConnection',
    ).mockResolvedValue({
      machineIdentifier: 'machine-id',
      serverName: 'Server Name',
      version: '1.0.0',
      musicLibraries: [],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/test-plex',
      payload: {
        baseUrl: 'http://localhost:32400',
        token: 'some-dummy-token-that-is-long-enough',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      machineIdentifier: 'machine-id',
      serverName: 'Server Name',
    })

    testConnectionSpy.mockRestore()
  })
})


describe('proposal export idempotency', () => {
  it.each(['exported', 'dismissed'])('does not create a Plex playlist for a %s proposal', async (status) => {
    const database = (async (strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      if (sql.includes('FROM playlist_proposals')) return [{ id: '9ad3649a-a78f-4aea-99dc-473c7c1c5501', title: 'Mix', kind: 'daily_mix', algorithm_version: 'test', status, plex_playlist_rating_key: status === 'exported' ? 'old-key' : null, created_at: '2026-09-30T00:00:00Z' }]
      return []
    }) as unknown as Database
    database.begin = (async (fn: (tx: Database) => Promise<unknown>) => fn(database)) as never
    const create = vi.spyOn(PlexClient.prototype, 'createPlaylist')
    const app = createServer({ database })
    await app.ready()
    const response = await app.inject({ method: 'POST', url: '/api/v1/playlists/proposals/9ad3649a-a78f-4aea-99dc-473c7c1c5501/export-to-plex', headers: { cookie: `musearr_session=${app.jwt.sign({ sub: 'owner-id', role: 'owner' })}` } })
    expect(response.statusCode).toBe(status === 'exported' ? 200 : 409)
    if (status === 'exported') expect(response.json().plexPlaylistRatingKey).toBe('old-key')
    expect(create).not.toHaveBeenCalled()
  })
})


it('serializes concurrent first exports and returns the original key on retry', async () => {
  const encryptionKey = Buffer.alloc(32, 7).toString('base64')
  let status = 'draft'
  let ratingKey: string | null = null
  let tail = Promise.resolve()
  const statements: string[] = []
  const database = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ')
    statements.push(sql)
    if (sql.includes('FROM playlist_proposals') && !sql.includes('FOR UPDATE')) return [{ id: '9ad3649a-a78f-4aea-99dc-473c7c1c5501', title: 'Mix', kind: 'daily_mix', algorithm_version: 'test', status, plex_playlist_rating_key: ratingKey, created_at: '2026-09-30T00:00:00Z' }]
    if (sql.includes('JOIN plex_servers')) return [{ base_url: 'http://plex.local', token_ciphertext: encryptSecret('token', encryptionKey) }]
    if (sql.includes('UPDATE playlist_proposals')) { status = 'exported'; ratingKey = values[0] as string }
    return []
  }) as unknown as Database
  database.begin = (async (fn: (tx: Database) => Promise<unknown>) => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await fn(database) } finally { release() }
  }) as never
  const create = vi.spyOn(PlexClient.prototype, 'createPlaylist').mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return { plexRatingKey: 'first-key', title: 'Mix' }
  })
  const app = createServer({ database, encryptionKey })
  await app.ready()
  const request = { method: 'POST' as const, url: '/api/v1/playlists/proposals/9ad3649a-a78f-4aea-99dc-473c7c1c5501/export-to-plex', headers: { cookie: `musearr_session=${app.jwt.sign({ sub: 'owner-id', role: 'owner' })}` } }
  const results = await Promise.all([app.inject(request), app.inject(request)])
  expect(results.map(result => result.statusCode)).toEqual([200, 200])
  expect(results.map(result => result.json().plexPlaylistRatingKey)).toEqual(['first-key', 'first-key'])
  expect(create).toHaveBeenCalledOnce()
  expect(statements[0]).toContain('FOR UPDATE')
})


describe('setup Plex PIN ownership (#82)', () => {
  it('rejects arbitrary and cross-browser PINs before contacting Plex', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/api/v2/pins')) return Response.json({ id: 42, code: 'fixture', authToken: null });
      if (url.endsWith('/api/v2/pins/42')) return Response.json({ authToken: null });
      if (url.includes('/resources')) return Response.json([]);
      return Response.json({ authToken: 'victim-token' });
    });
    const app = createServer({ database: (async () => []) as unknown as Database });
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/setup/plex-pin/99999' });
    expect(unknown.statusCode).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    const started = await app.inject({ method: 'POST', url: '/api/v1/setup/plex-pin' });
    expect(started.statusCode).toBe(200);
    const cookieHeader = String(started.headers['set-cookie']).split(';')[0];
    const calls = fetchSpy.mock.calls.length;
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup/plex-pin/42' })).statusCode).toBe(404);
    expect(fetchSpy.mock.calls.length).toBe(calls);
    const own = await app.inject({ method: 'GET', url: '/api/v1/setup/plex-pin/42', headers: { cookie: cookieHeader } });
    expect(own.statusCode).toBe(200);
    expect(own.json().authToken).toBeNull();
    expect(String(started.headers['set-cookie'])).toContain('HttpOnly');
    fetchSpy.mockImplementation(async input => String(input).includes('/resources') ? Response.json([]) : Response.json({ authToken: 'own-fixture-token' }));
    const completed = await app.inject({ method: 'GET', url: '/api/v1/setup/plex-pin/42', headers: { cookie: cookieHeader } });
    expect(completed.json().authToken).toBe('own-fixture-token');
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup/plex-pin/42', headers: { cookie: cookieHeader } })).statusCode).toBe(404);
    // A fresh issued PIN expires locally even if an upstream still returns a token.
    fetchSpy.mockImplementation(async () => Response.json({ id: 43, code: 'fixture', authToken: null }));
    const fresh = await app.inject({ method: 'POST', url: '/api/v1/setup/plex-pin' });
    const freshCookie = String(fresh.headers['set-cookie']).split(';')[0];
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
    const beforeExpired = fetchSpy.mock.calls.length;
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup/plex-pin/43', headers: { cookie: freshCookie } })).statusCode).toBe(404);
    expect(fetchSpy.mock.calls.length).toBe(beforeExpired);
    dateNow.mockRestore();
  });
});

describe('session lifetime', () => {
  it('issues a login token that expires with the 30 day cookie', async () => {
    const passwordHash = await hashPassword('correct horse battery')
    const database = (async () => [{ id: 'user-1', password_hash: passwordHash, role: 'owner' }]) as unknown as Database
    const app = createServer({ database })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://musearr.test' },
      payload: { username: 'owner', password: 'correct horse battery' },
    })

    expect(response.statusCode).toBe(204)
    const token = String(response.headers['set-cookie']).split(';')[0]!.split('=')[1]!
    const claims = app.jwt.decode<{ iat: number; exp?: number }>(token)
    expect(claims?.exp).toBeDefined()
    expect(claims!.exp! - claims!.iat).toBe(60 * 60 * 24 * 30)
  })

  it('rejects a legacy token with no exp once it is older than the session lifetime', async () => {
    const app = createServer()
    await app.ready()
    const day = 60 * 60 * 24
    const now = Math.floor(Date.now() / 1000)
    const old = app.jwt.sign({ sub: 'owner-id', role: 'owner', iat: now - 31 * day } as { sub: string; role: 'owner' })
    const recent = app.jwt.sign({ sub: 'owner-id', role: 'owner', iat: now - 29 * day } as { sub: string; role: 'owner' })
    expect(app.jwt.decode<{ exp?: number }>(old)?.exp).toBeUndefined()

    const stale = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `musearr_session=${old}` } })
    const fresh = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `musearr_session=${recent}` } })
    expect(stale.statusCode).toBe(401)
    expect(fresh.statusCode).not.toBe(401)
  })
})

describe('session revocation (#96)', () => {
  function memorySessions(initial: Record<string, number | null>) {
    const versions = new Map(Object.entries(initial))
    return {
      versions,
      store: {
        version: async (id: string) => versions.get(id) ?? null,
        revoke: async (id: string, expected: number) => { if (versions.get(id) === expected) versions.set(id, expected + 1) },
      },
    }
  }
  const me = (app: ReturnType<typeof createServer>, token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `musearr_session=${token}` } })

  it('stops a copied token working after logout', async () => {
    const { store } = memorySessions({ 'owner-id': 0 })
    const app = createServer({ sessions: store })
    await app.ready()
    const token = app.jwt.sign({ sub: 'owner-id', role: 'owner', sv: 0 })
    expect((await me(app, token)).statusCode).toBe(200)
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `musearr_session=${token}`, origin: 'https://musearr.test' } })
    expect(logout.statusCode).toBe(204)
    expect((await me(app, token)).statusCode).toBe(401)
  })

  it('treats tokens issued before versions existed as version 0 and revokes them too', async () => {
    const { store } = memorySessions({ 'owner-id': 0 })
    const app = createServer({ sessions: store })
    await app.ready()
    const legacy = app.jwt.sign({ sub: 'owner-id', role: 'owner' })
    expect((await me(app, legacy)).statusCode).toBe(200)
    await store.revoke('owner-id', 0)
    expect((await me(app, legacy)).statusCode).toBe(401)
  })

  it('rejects tokens for a disabled or deleted user and tokens with a stale version', async () => {
    const { store } = memorySessions({ 'owner-id': 2, 'gone-id': null })
    const app = createServer({ sessions: store })
    await app.ready()
    expect((await me(app, app.jwt.sign({ sub: 'gone-id', role: 'member', sv: 0 }))).statusCode).toBe(401)
    expect((await me(app, app.jwt.sign({ sub: 'owner-id', role: 'owner', sv: 1 }))).statusCode).toBe(401)
    expect((await me(app, app.jwt.sign({ sub: 'owner-id', role: 'owner', sv: 2 }))).statusCode).toBe(200)
  })

  it('does not report successful logout when session revocation fails', async () => {
    const revoke = vi.fn(async () => { throw new Error('database unavailable') })
    const app = createServer({ sessions: { version: async () => 0, revoke } })
    await app.ready()
    const token = app.jwt.sign({ sub: 'owner-id', role: 'owner', sv: 0 })
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `musearr_session=${token}`, origin: 'https://musearr.test' } })
    expect(response.statusCode).toBe(500)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(revoke).toHaveBeenCalledWith('owner-id', 0)
    expect((await me(app, token)).statusCode).toBe(200)
  })

  it('still revokes on logout when the version lookup is failing', async () => {
    const revoke = vi.fn(async () => undefined)
    const app = createServer({ sessions: { version: async () => { throw new Error('database unavailable') }, revoke } })
    await app.ready()
    const token = app.jwt.sign({ sub: 'owner-id', role: 'owner', sv: 0 })
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `musearr_session=${token}`, origin: 'https://musearr.test' } })
    expect(response.statusCode).toBe(204)
    expect(revoke).toHaveBeenCalledWith('owner-id', 0)
  })

  it('a stale token cannot bump the version again by calling logout', async () => {
    const { store, versions } = memorySessions({ 'owner-id': 5 })
    const revoke = vi.fn(store.revoke)
    const app = createServer({ sessions: { ...store, revoke } })
    await app.ready()
    const stale = app.jwt.sign({ sub: 'owner-id', role: 'owner', sv: 0 })
    const current = app.jwt.sign({ sub: 'owner-id', role: 'owner', sv: 5 })
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `musearr_session=${stale}`, origin: 'https://musearr.test' } })
    expect(response.statusCode).toBe(204)
    // The token's own version travels with the revoke, so the store can refuse a stale one.
    expect(revoke).toHaveBeenCalledWith('owner-id', 0)
    expect(versions.get('owner-id')).toBe(5)
    expect((await me(app, current)).statusCode).toBe(200)
  })

  it('logout without a valid session still clears the cookie and revokes nothing', async () => {
    const revoke = vi.fn(async () => undefined)
    const app = createServer({ sessions: { version: async () => 0, revoke } })
    await app.ready()
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { origin: 'https://musearr.test' } })
    expect(response.statusCode).toBe(204)
    expect(String(response.headers['set-cookie'])).toContain('musearr_session=;')
    expect(revoke).not.toHaveBeenCalled()
  })
})
