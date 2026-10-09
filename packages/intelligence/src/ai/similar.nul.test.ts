import { describe, expect, it } from 'vitest'
import { LocalAiSimilarTrackProvider, parseSuggestions } from './similar.js'
import type { LocalAiProvider } from './provider.js'

describe('Postgres-safe model suggestions', () => {
  const entries = [
    { artist: 'Bad\u0000artist', title: 'Song' },
    { artist: 'Artist', title: 'Bad\u0000title' },
    { artist: 'Artist', title: 'Song', album: 'Bad\u0000album' },
    { artist: ' Björk ', title: ' Jóga ', album: ' Homogenic ' },
  ]
  const expected = [{ artistName: 'Björk', trackTitle: 'Jóga', albumTitle: 'Homogenic', source: 'local-ai:ollama' }]

  it('skips NUL-bearing rows while preserving valid Unicode metadata', () => {
    expect(parseSuggestions(JSON.stringify(entries), 'local-ai:ollama')).toEqual(expected)
  })

  it('filters invalid rows before applying the requested suggestion limit', async () => {
    const ai: LocalAiProvider = {
      name: 'ollama', enabled: true, model: 'model', baseUrl: 'http://ai.local',
      isReachable: async () => true,
      complete: async () => JSON.stringify(entries),
      embed: async () => [],
    }
    const provider = new LocalAiSimilarTrackProvider(ai)
    expect(await provider.findSimilar({ artistName: 'Seed', trackTitle: 'Seed song', albumTitle: null, genres: [] }, 1)).toEqual(expected)
  })
})
