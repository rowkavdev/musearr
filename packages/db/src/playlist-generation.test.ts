import { describe, expect, it } from 'vitest'
import { matchGenerationItemsInLibrary } from './playlist-generation.js'
import type { Database } from './repository.js'

describe('acquired recording match query', () => {
  it('requires a supplied album and only accepts a single candidate recording', async () => {
    let query = ''
    const database = (async (strings: TemplateStringsArray) => {
      query = strings.join('?').replace(/\s+/g, ' ')
      return { count: 1 }
    }) as unknown as Database
    expect(await matchGenerationItemsInLibrary(database, 'generation')).toBe(1)
    expect(query).toContain('LOWER(candidate.album_title) = LOWER(al.title)')
    expect(query).toContain('candidate.album_title IS NULL')
    expect(query).toContain('HAVING COUNT(*) = 1')
    expect(query).toContain('pgi.id = m.item_id')
  })
})
