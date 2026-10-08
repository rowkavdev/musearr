import type { ExternalTrackSuggestion } from './playlist.js'

export type SimilarSeed = {
  artistName: string
  trackTitle: string
  albumTitle: string | null
  genres: string[]
}

/**
 * Source of "tracks like this seed that may not be in the library yet". The
 * deterministic pipeline uses {@link NullSimilarTrackProvider}, which returns
 * nothing, so a generation is library-only unless an optional provider (for
 * example a local-AI model the owner runs) is wired in.
 */
export interface SimilarTrackProvider {
  readonly name: string
  findSimilar(seed: SimilarSeed, limit: number): Promise<ExternalTrackSuggestion[]>
}

export class NullSimilarTrackProvider implements SimilarTrackProvider {
  readonly name = 'none'

  async findSimilar(): Promise<ExternalTrackSuggestion[]> {
    return []
  }
}

/**
 * Queries providers in order and merges their suggestions, de-duplicating by
 * artist + title, until `limit` is reached. A provider that throws is skipped.
 * Order matters: put deterministic sources before generative ones.
 */
export class CompositeSimilarTrackProvider implements SimilarTrackProvider {
  readonly name: string

  constructor(private readonly providers: SimilarTrackProvider[]) {
    this.name = providers.map((provider) => provider.name).join('+') || 'none'
  }

  async findSimilar(seed: SimilarSeed, limit: number): Promise<ExternalTrackSuggestion[]> {
    const merged: ExternalTrackSuggestion[] = []
    const seen = new Set<string>()

    for (const provider of this.providers) {
      if (merged.length >= limit) {
        break
      }
      let batch: ExternalTrackSuggestion[]
      try {
        batch = await provider.findSimilar(seed, limit - merged.length)
      } catch {
        batch = []
      }
      for (const suggestion of batch) {
        const artist = suggestion.artistName.trim()
        const title = suggestion.trackTitle.trim()
        if (!artist || !title) {
          continue
        }
        const key = JSON.stringify([artist.toLocaleLowerCase(), title.toLocaleLowerCase()])
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        merged.push(suggestion)
        if (merged.length >= limit) {
          break
        }
      }
    }
    return merged
  }
}
