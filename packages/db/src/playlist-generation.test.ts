import { describe, expect, it } from 'vitest'
import { getGenerationIdsAwaitingAcquisition, matchGenerationItemsInLibrary } from './playlist-generation.js'
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

describe('getGenerationIdsAwaitingAcquisition', () => {
  it('selects only generations that still need the sweep, least recently touched first', async () => {
    let query = ''
    const database = (async (strings: TemplateStringsArray) => {
      query = strings.join('?').replace(/\s+/g, ' ')
      return []
    }) as unknown as Database
    expect(await getGenerationIdsAwaitingAcquisition(database)).toEqual([])
    // A non-publishing 'ready' generation is terminal: nothing advances it, but an
    // unbounded history of them fills the 50-row cap by created_at and starves
    // every newer generation out of reconciliation.
    expect(query).toContain("status = 'ready' AND publish_to_plex")
    expect(query).not.toContain("status IN ('awaiting_acquisition', 'ready', 'publishing')")
    // The sweep bumps updated_at on every scanned row, so this rotates the window
    // instead of pinning the same 50 oldest rows forever.
    expect(query).toContain('ORDER BY updated_at ASC')
  })
})
