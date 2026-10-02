import { describe, expect, it, vi } from 'vitest'
import { LocalAiSimilarTrackProvider, parseSuggestions } from './similar.js'
import type { LocalAiProvider } from './provider.js'

function fakeAi(overrides: Partial<LocalAiProvider> = {}): LocalAiProvider {
  return {
    name: 'ollama',
    enabled: true,
    model: 'm',
    baseUrl: 'http://ai.local',
    isReachable: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue('[]'),
    embed: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

const seed = { artistName: 'Artist', trackTitle: 'Song', albumTitle: 'Album', genres: ['rock', 'indie'] }

describe('parseSuggestions', () => {
  it('reads a JSON array wrapped in prose or code fences', () => {
    const raw = 'Sure!\n```json\n[{"artist":" A ","title":" T ","album":" Al "}]\n```'
    expect(parseSuggestions(raw, 'src')).toEqual([
      { artistName: 'A', trackTitle: 'T', albumTitle: 'Al', source: 'src' },
    ])
  })

  it('skips entries without an artist or title and non-object entries', () => {
    const raw = JSON.stringify([
      { artist: 'A' },
      { title: 'T' },
      { artist: '  ', title: 'T' },
      null,
      'text',
      42,
      { artist: 'B', title: 'U' },
    ])
    expect(parseSuggestions(raw, 's')).toEqual([{ artistName: 'B', trackTitle: 'U', albumTitle: null, source: 's' }])
  })

  it('treats a blank or non-string album as missing', () => {
    const raw = JSON.stringify([
      { artist: 'A', title: 'T', album: '   ' },
      { artist: 'B', title: 'U', album: 7 },
    ])
    expect(parseSuggestions(raw, 's').map((s) => s.albumTitle)).toEqual([null, null])
  })

  it.each(['', 'no json here', '[not json]', '] reversed [', '{"artist":"A","title":"T"}'])(
    'returns an empty list for unusable output %j',
    (raw) => {
      expect(parseSuggestions(raw, 's')).toEqual([])
    },
  )
})

describe('LocalAiSimilarTrackProvider', () => {
  it('names itself after the underlying provider', () => {
    expect(new LocalAiSimilarTrackProvider(fakeAi()).name).toBe('local-ai:ollama')
  })

  it('does not call the model when the provider is disabled', async () => {
    const ai = fakeAi({ enabled: false })
    expect(await new LocalAiSimilarTrackProvider(ai).findSimilar(seed, 5)).toEqual([])
    expect(ai.complete).not.toHaveBeenCalled()
  })

  it('degrades to an empty list when the model call throws', async () => {
    const ai = fakeAi({ complete: vi.fn().mockRejectedValue(new Error('down')) })
    expect(await new LocalAiSimilarTrackProvider(ai).findSimilar(seed, 5)).toEqual([])
  })

  it('asks for the seed and limit, tags the source, and caps the result at the limit', async () => {
    const entries = [1, 2, 3].map((n) => ({ artist: `A${n}`, title: `T${n}` }))
    const ai = fakeAi({ complete: vi.fn().mockResolvedValue(JSON.stringify(entries)) })
    const result = await new LocalAiSimilarTrackProvider(ai).findSimilar(seed, 2)
    expect(result.map((s) => s.trackTitle)).toEqual(['T1', 'T2'])
    expect(result.every((s) => s.source === 'local-ai:ollama')).toBe(true)
    const request = vi.mocked(ai.complete).mock.calls[0]![0]
    expect(request.prompt).toContain('"Song" by Artist from the album "Album" (genres: rock, indie)')
    expect(request.prompt).toContain('up to 2 similar tracks')
  })

  it('leaves out the album and genre text when the seed has none', async () => {
    const ai = fakeAi()
    await new LocalAiSimilarTrackProvider(ai).findSimilar({ ...seed, albumTitle: null, genres: [] }, 3)
    expect(vi.mocked(ai.complete).mock.calls[0]![0].prompt).toBe(
      'Seed track: "Song" by Artist. Suggest up to 3 similar tracks.',
    )
  })
})
