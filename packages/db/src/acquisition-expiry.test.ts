import { expect, it } from 'vitest'
import { expireStalledGenerationItems } from './playlist-generation.js'
import type { Database } from './repository.js'

it('expires waits by request time, not repeated updated_at writes, with a legacy fallback', async () => {
  let query = ''
  const database = (async (strings: TemplateStringsArray) => { query = strings.join('?').replace(/\s+/g, ' '); return [] }) as unknown as Database
  await expireStalledGenerationItems(database, 'generation')
  expect(query).toContain("state IN ('requested', 'downloading', 'imported')")
  expect(query).toContain("COALESCE(acquisition_requested_at, created_at) < NOW() - INTERVAL '24 hours'")
  expect(query).toContain("SET state = 'unavailable'")
})
