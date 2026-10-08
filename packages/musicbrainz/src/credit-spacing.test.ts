import { expect, test } from 'vitest'
import { MusicBrainzClient } from './client.js'

for (const joinphrase of [' feat. ', ' & ', ' ']) {
  test(`recording credit preserves the literal join phrase ${JSON.stringify(joinphrase)}`, async () => {
    const client = new MusicBrainzClient({ contact: 'fixture@example.com', minRequestIntervalMs: 0,
      fetchImpl: (async () => Response.json({ title: 'Song', 'artist-credit': [
        { name: 'First', joinphrase }, { name: 'Second' },
      ] })) as typeof fetch,
    })
    expect((await client.lookupRecording('fixture'))?.artistName).toBe(`First${joinphrase}Second`)
  })
}

test('recording credit still trims the final assembled name and ignores a non-string joinphrase', async () => {
  const client = new MusicBrainzClient({ contact: 'fixture@example.com', minRequestIntervalMs: 0,
    fetchImpl: (async () => Response.json({ title: 'Song', 'artist-credit': [
      { name: ' First ', joinphrase: 123 },
    ] })) as typeof fetch,
  })
  expect((await client.lookupRecording('fixture'))?.artistName).toBe('First')
})
