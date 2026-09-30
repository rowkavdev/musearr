/**
 * Deterministic "playlist from a seed song" planner.
 *
 * Given one seed track and the local library mirror, it produces an ordered
 * list of library tracks that fit the seed. When the caller also passes
 * external suggestions (for example from an optional local-AI similar-track
 * provider), tracks that are not already in the library are appended as "gap"
 * items for an optional Lidarr acquisition step.
 *
 * The planner is pure and free of randomness: the same inputs always yield the
 * same plan, so a generation can be reproduced and explained.
 */

export const PLAYLIST_ALGORITHM_VERSION = '2026-08-27.1'

export type PlaylistLibraryTrack = {
  trackId: string
  plexRatingKey: string
  artistId: string
  artistName: string
  albumId: string
  albumTitle: string
  trackTitle: string
  genres: string[]
  year: number | null
  rating: number | null
  playCount: number
  lastPlayedAt: string | null
}

export type ExternalTrackSuggestion = {
  artistName: string
  trackTitle: string
  albumTitle: string | null
  source: string
}

export type PlaylistReasonCode =
  | 'SEED_ARTIST'
  | 'SHARED_GENRE'
  | 'SIMILAR_ERA'
  | 'HIGH_RATING'
  | 'FAMILIAR'
  | 'DISCOVERY'
  | 'EXTERNAL_SUGGESTION'

export type PlaylistReason = {
  code: PlaylistReasonCode
  weight: number
  facts: Record<string, string | number>
}

export type PlaylistPlanItem = {
  position: number
  trackId: string | null
  plexRatingKey: string | null
  artistName: string
  albumTitle: string | null
  trackTitle: string
  inLibrary: boolean
  score: number
  reasons: PlaylistReason[]
}

export type PlaylistPlan = {
  seedTrackId: string
  algorithmVersion: string
  items: PlaylistPlanItem[]
  inLibraryCount: number
  gapCount: number
}

export type GeneratePlaylistOptions = {
  targetSize?: number
  externalSuggestions?: ExternalTrackSuggestion[]
}

const DEFAULT_TARGET_SIZE = 25
const MAX_PER_ARTIST = 2
const MAX_PER_SEED_ARTIST = 3

type ScoredLibraryItem = {
  track: PlaylistLibraryTrack
  score: number
  reasons: PlaylistReason[]
}

export function generateFromSeed(
  seed: PlaylistLibraryTrack,
  library: PlaylistLibraryTrack[],
  options: GeneratePlaylistOptions = {},
): PlaylistPlan {
  const targetSize = clampInt(options.targetSize ?? DEFAULT_TARGET_SIZE, 5, 100)
  const seedGenres = new Set(seed.genres.map(normaliseGenre).filter(Boolean))
  let maxPlayCount = 1
  for (const track of library) maxPlayCount = Math.max(maxPlayCount, track.playCount)

  const scored = library
    .filter((track) => track.trackId !== seed.trackId)
    .map((track) => scoreLibraryTrack(seed, seedGenres, track, maxPlayCount))
    .filter((entry): entry is ScoredLibraryItem => entry !== null)
    .sort((left, right) => right.score - left.score || left.track.trackId.localeCompare(right.track.trackId))

  const selected = diversify(seed.artistId, scored, targetSize)
  const items: PlaylistPlanItem[] = selected.map((entry, index) => ({
    position: index,
    trackId: entry.track.trackId,
    plexRatingKey: entry.track.plexRatingKey,
    artistName: entry.track.artistName,
    albumTitle: entry.track.albumTitle,
    trackTitle: entry.track.trackTitle,
    inLibrary: true,
    score: round(entry.score),
    reasons: entry.reasons.slice(0, 3),
  }))

  const gapItems = buildGapItems(
    options.externalSuggestions ?? [],
    library,
    items,
    targetSize - items.length,
    items.length,
  )

  return {
    seedTrackId: seed.trackId,
    algorithmVersion: PLAYLIST_ALGORITHM_VERSION,
    items: [...items, ...gapItems],
    inLibraryCount: items.length,
    gapCount: gapItems.length,
  }
}

function scoreLibraryTrack(
  seed: PlaylistLibraryTrack,
  seedGenres: Set<string>,
  track: PlaylistLibraryTrack,
  maxPlayCount: number,
): ScoredLibraryItem | null {
  const trackGenres = track.genres.map(normaliseGenre).filter(Boolean)
  const sharedGenres = trackGenres.filter((genre) => seedGenres.has(genre))
  const genreSignal =
    seedGenres.size === 0 ? 0 : sharedGenres.length / Math.max(seedGenres.size, trackGenres.length || 1)
  const sameArtist = track.artistId === seed.artistId
  const eraSignal = eraProximity(seed.year, track.year)
  const ratingSignal = track.rating === null ? 0.5 : clamp(track.rating / 10, 0, 1)
  const playSignal = clamp(Math.log1p(Math.max(0, track.playCount)) / Math.log1p(maxPlayCount), 0, 1)
  const familiarityBlend = track.playCount === 0 ? 0.55 : playSignal

  if (!sameArtist && genreSignal === 0) {
    // Keep the plan anchored to the seed: no genre overlap and a different
    // artist means we have no deterministic reason to include the track.
    return null
  }

  const score =
    genreSignal * 0.4 +
    eraSignal * 0.15 +
    ratingSignal * 0.15 +
    (sameArtist ? 1 : 0) * 0.15 +
    familiarityBlend * 0.15

  const reasons: PlaylistReason[] = []
  if (sameArtist) {
    reasons.push({ code: 'SEED_ARTIST', weight: 1, facts: { artist: seed.artistName } })
  }
  if (sharedGenres.length > 0) {
    reasons.push({
      code: 'SHARED_GENRE',
      weight: round(genreSignal),
      facts: { genre: sharedGenres[0] as string, shared: sharedGenres.length },
    })
  }
  if (eraSignal >= 0.6 && seed.year !== null && track.year !== null) {
    reasons.push({
      code: 'SIMILAR_ERA',
      weight: round(eraSignal),
      facts: { seedYear: seed.year, trackYear: track.year },
    })
  }
  if ((track.rating ?? 0) >= 8) {
    reasons.push({ code: 'HIGH_RATING', weight: round(ratingSignal), facts: { rating: track.rating as number } })
  }
  if (track.playCount === 0) {
    reasons.push({ code: 'DISCOVERY', weight: 0.55, facts: { playCount: 0 } })
  } else if (track.playCount >= 3) {
    reasons.push({ code: 'FAMILIAR', weight: round(playSignal), facts: { playCount: track.playCount } })
  }

  return {
    track,
    score: clamp(score, 0, 1),
    reasons: reasons.sort((left, right) => right.weight - left.weight),
  }
}

function diversify(
  seedArtistId: string,
  scored: ScoredLibraryItem[],
  limit: number,
): ScoredLibraryItem[] {
  const selected: ScoredLibraryItem[] = []
  const artistCounts = new Map<string, number>()
  const albumIds = new Set<string>()

  for (const entry of scored) {
    if (selected.length >= limit) {
      break
    }
    const artistCount = artistCounts.get(entry.track.artistId) ?? 0
    const artistCap = entry.track.artistId === seedArtistId ? MAX_PER_SEED_ARTIST : MAX_PER_ARTIST
    if (artistCount >= artistCap || albumIds.has(entry.track.albumId)) {
      continue
    }
    selected.push(entry)
    artistCounts.set(entry.track.artistId, artistCount + 1)
    albumIds.add(entry.track.albumId)
  }

  return selected
}

function buildGapItems(
  suggestions: ExternalTrackSuggestion[],
  library: PlaylistLibraryTrack[],
  chosen: PlaylistPlanItem[],
  slots: number,
  startPosition: number,
): PlaylistPlanItem[] {
  if (slots <= 0 || suggestions.length === 0) {
    return []
  }

  const seen = new Set<string>()
  for (const track of library) {
    seen.add(trackKey(track.artistName, track.trackTitle))
  }
  for (const item of chosen) {
    seen.add(trackKey(item.artistName, item.trackTitle))
  }

  const gaps: PlaylistPlanItem[] = []
  for (const suggestion of suggestions) {
    if (gaps.length >= slots) {
      break
    }
    const key = trackKey(suggestion.artistName, suggestion.trackTitle)
    if (!suggestion.artistName.trim() || !suggestion.trackTitle.trim() || seen.has(key)) {
      continue
    }
    seen.add(key)
    gaps.push({
      position: startPosition + gaps.length,
      trackId: null,
      plexRatingKey: null,
      artistName: suggestion.artistName.trim(),
      albumTitle: suggestion.albumTitle?.trim() ? suggestion.albumTitle.trim() : null,
      trackTitle: suggestion.trackTitle.trim(),
      inLibrary: false,
      score: 0,
      reasons: [{ code: 'EXTERNAL_SUGGESTION', weight: 1, facts: { source: suggestion.source } }],
    })
  }
  return gaps
}

function eraProximity(seedYear: number | null, trackYear: number | null): number {
  if (seedYear === null || trackYear === null) {
    return 0
  }
  return 1 - clamp(Math.abs(seedYear - trackYear) / 25, 0, 1)
}

function trackKey(artistName: string, trackTitle: string): string {
  return `${normaliseGenre(artistName)}::${normaliseGenre(trackTitle)}`
}

function normaliseGenre(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.round(clamp(value, minimum, maximum))
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
