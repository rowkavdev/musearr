import type { ExternalTrackSuggestion } from '../playlist.js'
import type { SimilarSeed, SimilarTrackProvider } from '../similar.js'
import type { LocalAiProvider } from './provider.js'

const SYSTEM_PROMPT =
  'You are a music librarian. Given a seed track, list similar tracks a listener would enjoy. ' +
  'Reply with ONLY a JSON array of objects with keys "artist", "title", and optional "album". No prose.'

/**
 * Bridges the optional local-AI provider to the deterministic playlist planner
 * as a source of gap suggestions. Every failure mode (disabled provider, model
 * error, unparseable output) degrades to an empty list, so the planner stays
 * library-only rather than producing junk.
 */
export class LocalAiSimilarTrackProvider implements SimilarTrackProvider {
  readonly name: string

  constructor(private readonly ai: LocalAiProvider) {
    this.name = `local-ai:${ai.name}`
  }

  async findSimilar(seed: SimilarSeed, limit: number): Promise<ExternalTrackSuggestion[]> {
    if (!this.ai.enabled) {
      return []
    }

    let raw: string
    try {
      raw = await this.ai.complete({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(seed, limit),
        temperature: 0.3,
        maxTokens: 512,
      })
    } catch {
      return []
    }

    return parseSuggestions(raw, `local-ai:${this.ai.name}`).slice(0, limit)
  }
}

function buildPrompt(seed: SimilarSeed, limit: number): string {
  const genres = seed.genres.length > 0 ? ` (genres: ${seed.genres.join(', ')})` : ''
  const album = seed.albumTitle ? ` from the album "${seed.albumTitle}"` : ''
  return `Seed track: "${seed.trackTitle}" by ${seed.artistName}${album}${genres}. Suggest up to ${limit} similar tracks.`
}

export function parseSuggestions(raw: string, source: string): ExternalTrackSuggestion[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }

  const suggestions: ExternalTrackSuggestion[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const record = entry as Record<string, unknown>
    const artistName = typeof record.artist === 'string' ? record.artist.trim() : ''
    const trackTitle = typeof record.title === 'string' ? record.title.trim() : ''
    const albumTitle = typeof record.album === 'string' && record.album.trim() ? record.album.trim() : null
    // Model output is untrusted text. Postgres rejects NUL in text columns;
    // one bad suggestion must not fail an otherwise usable generation.
    if (!artistName || !trackTitle || [artistName, trackTitle, albumTitle].some((value) => value?.includes('\u0000'))) {
      continue
    }
    suggestions.push({
      artistName,
      trackTitle,
      albumTitle,
      source,
    })
  }
  return suggestions
}
