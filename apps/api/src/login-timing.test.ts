import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@musearr/db'

const verifyPassword = vi.hoisted(() => vi.fn(async () => false))
const hashPassword = vi.hoisted(() => vi.fn(async () => 'scrypt$1$1$1$c2FsdA$aGFzaA'))

vi.mock('@musearr/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@musearr/core')>()),
  verifyPassword,
  hashPassword,
}))

const { getConfig } = await import('@musearr/config')
const { buildServer } = await import('./server.js')

const apps: Array<ReturnType<typeof buildServer>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function createServer(options: { database: Database }) {
  const app = buildServer({
    config: getConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://musearr:musearr@localhost:5432/musearr',
      MUSEARR_WEB_ORIGIN: 'https://musearr.test',
      MUSEARR_TRUST_PROXY: 'true',
      MUSEARR_SESSION_SECRET: 'a-session-secret-that-is-at-least-thirty-two-characters',
    }),
    database: options.database,
    startJobQueue: false,
    sessions: { version: async () => 0, revoke: async () => undefined },
  })
  apps.push(app)
  return app
}

describe('login timing', () => {
  it('still runs a password check when the username does not exist', async () => {
    const database = (async () => []) as unknown as Database
    const app = createServer({ database })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://musearr.test' },
      payload: { username: 'nobody', password: 'whatever-it-is' },
    })

    expect(response.statusCode).toBe(401)
    expect(verifyPassword).toHaveBeenCalledTimes(1)
  })

  it('builds the dummy hash at startup so the first unknown-user login does no extra hashing', async () => {
    hashPassword.mockClear()
    const app = createServer({ database: (async () => []) as unknown as Database })
    await app.ready()
    expect(hashPassword).toHaveBeenCalledTimes(1)

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://musearr.test' },
      payload: { username: 'nobody', password: 'whatever-it-is' },
    })
    expect(hashPassword).toHaveBeenCalledTimes(1)
  })
})
