import { expect, test } from 'vitest'
import { importScrobbles, type Database } from './repository.js'

test('#109 candidate query includes only normalized requested artist/title pairs', async () => {
  let candidates = 0
  const database = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?')
    if (query.includes('FROM plex_servers')) return [{ id: '00000000-0000-4000-8000-000000000001' }]
    if (query.includes('SELECT timezone')) return [{ timezone: 'UTC' }]
    if (query.includes('FROM tracks t')) {
      candidates++
      expect(query).toContain('jsonb_to_recordset')
      expect(query).toContain('wanted.artist = LOWER(artist.name)')
      expect(query).toContain('wanted.title = LOWER(t.title)')
      const pairs = JSON.parse(values.find(value => typeof value === 'string' && value.startsWith('[')) as string)
      expect(pairs).toEqual([{ artist: 'slowdive', title: 'alison' }, { artist: 'ride', title: 'vapour trail' }])
      return [{ track_id: 'track-a', artist_name: 'slowdive', track_title: 'alison', album_title: 'souvlaki', duration_ms: 1 }]
    }
    if (query.includes('INSERT INTO listening_events')) return [] // idempotent reimport
    return []
  }) as unknown as Database
  database.begin = (async (work: (tx: Database) => unknown) => work(database)) as unknown as Database['begin']
  const result = await importScrobbles(database, 'user', [
    { artistName: ' Slowdive ', trackTitle: ' Alison ', occurredAt: '2026-09-01T00:00:00Z' },
    { artistName: 'slowdive', trackTitle: 'alison', occurredAt: '2026-09-02T00:00:00Z' },
    { artistName: 'Ride', trackTitle: 'Vapour Trail', occurredAt: '2026-09-03T00:00:00Z' },
  ])
  expect(candidates).toBe(1)
  expect(result).toEqual({ importedCount: 0, matchedTracksCount: 1, unmatchedCount: 1 })
})
