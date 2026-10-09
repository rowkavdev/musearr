import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from '@musearr/db'
import { generateDailyBrief } from './daily-brief.js'

const url = process.env.MUSEARR_TEST_DATABASE_URL
const suite = url ? it : it.skip

let database: Database
let userId: string

beforeAll(async () => {
  if (!url) return
  database = createDatabase(url)
  const [user] = await database<Array<{ id: string }>>`
    INSERT INTO users (username, password_hash, role, timezone)
    VALUES (${`brief-race-${Date.now()}`}, 'x', 'owner', 'UTC') RETURNING id
  `
  userId = user!.id
})

afterAll(async () => {
  if (!url) return
  await database`DELETE FROM users WHERE id = ${userId}`
  await database.end({ timeout: 5 })
})

suite('posts a daily brief to Discord once when two runs overlap', async () => {
  const content = { headline: 'Hi', summary: 'Sum', cards: [] }
  await database`
    INSERT INTO daily_briefs (user_id, brief_date, timezone, algorithm_version, content)
    VALUES (${userId}, '2026-10-09', 'UTC', ${(await import('@musearr/intelligence')).DAILY_BRIEF_ALGORITHM_VERSION}, ${JSON.stringify(content)}::text::jsonb)
  `
  let posts = 0
  vi.stubGlobal('fetch', async () => {
    posts += 1
    await new Promise((resolve) => setTimeout(resolve, 150))
    return new Response('{}', { status: 200 })
  })
  const options = {
    timezone: 'UTC',
    discordWebhookUrl: 'https://discord.example/api/webhooks/1/abc',
    now: new Date('2026-10-09T12:00:00Z'),
  }
  await Promise.all([generateDailyBrief(database, userId, options), generateDailyBrief(database, userId, options)])
  vi.unstubAllGlobals()
  expect(posts).toBe(1)
})
