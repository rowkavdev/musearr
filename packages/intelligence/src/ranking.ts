export const RECOMMENDATION_ALGORITHM_VERSION = '2026-08-05.2'

export type RecommendationKind =
  | 'daily_mix'
  | 'forgotten_favourites'
  | 'hidden_gems'
  | 'recently_added'

export type RecommendationCandidate = {
  trackId: string
  artistId: string
  artistName: string
  albumId: string
  albumTitle: string
  trackTitle: string
  genres: string[]
  addedAt: string | null
  lastPlayedAt: string | null
  rating: number | null
  playCount: number
}

export type RecommendationReasonCode =
  | 'FAVOURITE_ARTIST'
  | 'FAVOURITE_GENRE'
  | 'FORGOTTEN_FAVOURITE'
  | 'HIGH_RATING'
  | 'RECENTLY_ADDED'
  | 'UNDERPLAYED'
  | 'UNHEARD'
  | 'WELL_LOVED'

export type RecommendationReason = {
  code: RecommendationReasonCode
  weight: number
  facts: Record<string, number | string>
}

const PRIMARY_REASON_BY_KIND: Partial<Record<RecommendationKind, RecommendationReasonCode>> = {
  forgotten_favourites: 'FORGOTTEN_FAVOURITE',
  hidden_gems: 'UNDERPLAYED',
  recently_added: 'RECENTLY_ADDED',
}

export type RankedRecommendation = {
  trackId: string
  score: number
  reasons: RecommendationReason[]
  summary: string
}

type ScoredCandidate = RankedRecommendation & {
  artistId: string
  albumId: string
}

type RankingContext = {
  now: Date
  maxPlayCount: number
  artistAffinity: Map<string, number>
  genreAffinity: Map<string, number>
}

export function rankRecommendations(
  candidates: RecommendationCandidate[],
  kind: RecommendationKind,
  options: { limit?: number; now?: Date } = {},
): RankedRecommendation[] {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)))
  const now = options.now ?? new Date()
  const context = buildContext(candidates, now)

  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, kind, context))
    .filter((candidate): candidate is ScoredCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score || left.trackId.localeCompare(right.trackId))

  return diversify(scored, limit).map(({ artistId: _artistId, albumId: _albumId, ...result }) => result)
}

function buildContext(candidates: RecommendationCandidate[], now: Date): RankingContext {
  let maxPlayCount = 1
  for (const candidate of candidates) maxPlayCount = Math.max(maxPlayCount, candidate.playCount)
  const artistTotals = new Map<string, number>()
  const genreTotals = new Map<string, number>()

  for (const candidate of candidates) {
    const ratingSignal = candidate.rating === null ? 0 : candidate.rating / 10
    const playSignal = normalisePlayCount(candidate.playCount, maxPlayCount)
    const recentSignal = recencySignal(daysSince(candidate.lastPlayedAt, now), 120)
    const signal = playSignal * 0.7 + ratingSignal * 0.2 + recentSignal * 0.1

    artistTotals.set(candidate.artistId, (artistTotals.get(candidate.artistId) ?? 0) + signal)
    for (const genre of candidate.genres) {
      const key = genre.trim().toLocaleLowerCase()
      if (key) {
        genreTotals.set(key, (genreTotals.get(key) ?? 0) + signal)
      }
    }
  }

  return {
    now,
    maxPlayCount,
    artistAffinity: normaliseAffinity(artistTotals),
    genreAffinity: normaliseAffinity(genreTotals),
  }
}

function scoreCandidate(
  candidate: RecommendationCandidate,
  kind: RecommendationKind,
  context: RankingContext,
): ScoredCandidate | null {
  const daysSincePlayed = daysSince(candidate.lastPlayedAt, context.now)
  const daysSinceAdded = daysSince(candidate.addedAt, context.now)
  const playSignal = normalisePlayCount(candidate.playCount, context.maxPlayCount)
  const ratingSignal = candidate.rating === null ? 0.5 : clamp(candidate.rating / 10, 0, 1)
  const artistSignal = context.artistAffinity.get(candidate.artistId) ?? 0
  const genreSignal = highestGenreAffinity(candidate.genres, context.genreAffinity)
  const reasons: RecommendationReason[] = []

  if (artistSignal >= 0.45 && candidate.playCount > 0) {
    reasons.push({
      code: 'FAVOURITE_ARTIST',
      weight: round(artistSignal),
      facts: { artist: candidate.artistName, playCount: candidate.playCount },
    })
  }
  if (genreSignal >= 0.5) {
    const matchingGenre = candidate.genres.find(
      (genre) => (context.genreAffinity.get(genre.trim().toLocaleLowerCase()) ?? 0) === genreSignal,
    )
    if (matchingGenre) {
      reasons.push({
        code: 'FAVOURITE_GENRE',
        weight: round(genreSignal),
        facts: { genre: matchingGenre },
      })
    }
  }
  if ((candidate.rating ?? 0) >= 8) {
    reasons.push({ code: 'HIGH_RATING', weight: round(ratingSignal), facts: { rating: candidate.rating as number } })
  }
  if (candidate.playCount >= 5) {
    reasons.push({ code: 'WELL_LOVED', weight: round(playSignal), facts: { playCount: candidate.playCount } })
  }

  let score: number
  switch (kind) {
    case 'forgotten_favourites': {
      if (candidate.playCount < 3 || daysSincePlayed === null || daysSincePlayed < 60) {
        return null
      }
      const forgottenSignal = clamp((daysSincePlayed - 60) / 365, 0, 1)
      score = forgottenSignal * 0.48 + playSignal * 0.28 + ratingSignal * 0.14 + artistSignal * 0.1
      reasons.push({
        code: 'FORGOTTEN_FAVOURITE',
        weight: round(forgottenSignal),
        facts: { daysSincePlayed, playCount: candidate.playCount },
      })
      break
    }
    case 'hidden_gems': {
      const underplayedSignal = 1 - clamp(candidate.playCount / 5, 0, 1)
      const matureLibrarySignal = clamp((daysSinceAdded ?? 0) / 45, 0, 1)
      if (candidate.playCount > 5 || matureLibrarySignal === 0) {
        return null
      }
      score = underplayedSignal * 0.4 + ratingSignal * 0.25 + artistSignal * 0.2 + genreSignal * 0.1 + matureLibrarySignal * 0.05
      reasons.push({
        code: 'UNDERPLAYED',
        weight: round(underplayedSignal),
        facts: { playCount: candidate.playCount },
      })
      if (candidate.playCount === 0) {
        reasons.push({ code: 'UNHEARD', weight: 1, facts: { daysInLibrary: daysSinceAdded ?? 0 } })
      }
      break
    }
    case 'recently_added': {
      if (daysSinceAdded === null || daysSinceAdded > 45) {
        return null
      }
      const newnessSignal = 1 - clamp(daysSinceAdded / 45, 0, 1)
      score = newnessSignal * 0.45 + ratingSignal * 0.2 + artistSignal * 0.2 + genreSignal * 0.1 + (1 - playSignal) * 0.05
      reasons.push({ code: 'RECENTLY_ADDED', weight: round(newnessSignal), facts: { daysInLibrary: daysSinceAdded } })
      if (candidate.playCount === 0) {
        reasons.push({ code: 'UNHEARD', weight: 1, facts: { daysInLibrary: daysSinceAdded } })
      }
      break
    }
    case 'daily_mix': {
      const rediscoverySignal = daysSincePlayed === null ? 0.72 : clamp(daysSincePlayed / 45, 0, 1)
      const discoverySignal = candidate.playCount === 0 ? 1 : 0
      const fatigue = daysSincePlayed !== null && daysSincePlayed < 2 ? 0.3 : 0
      score =
        ratingSignal * 0.24 +
        playSignal * 0.2 +
        artistSignal * 0.24 +
        genreSignal * 0.14 +
        rediscoverySignal * 0.18 +
        discoverySignal * 0.18 -
        fatigue
      if (candidate.playCount === 0) {
        reasons.push({ code: 'UNHEARD', weight: round(rediscoverySignal), facts: { daysInLibrary: daysSinceAdded ?? 0 } })
      }
      break
    }
  }

  const primaryReason = PRIMARY_REASON_BY_KIND[kind]
  const orderedReasons = [...reasons]
    .sort((left, right) => {
      const priorityDifference = Number(right.code === primaryReason) - Number(left.code === primaryReason)
      return priorityDifference || right.weight - left.weight
    })
    .slice(0, 3)
  return {
    trackId: candidate.trackId,
    artistId: candidate.artistId,
    albumId: candidate.albumId,
    score: round(clamp(score, 0, 1)),
    reasons: orderedReasons,
    summary: buildSummary(candidate, kind, orderedReasons, daysSincePlayed, daysSinceAdded),
  }
}

function diversify(candidates: ScoredCandidate[], limit: number): ScoredCandidate[] {
  const selected: ScoredCandidate[] = []
  const artistCounts = new Map<string, number>()
  const albumCounts = new Map<string, number>()
  const remaining = [...candidates]

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (const [index, candidate] of remaining.entries()) {
      const artistPenalty = (artistCounts.get(candidate.artistId) ?? 0) * 0.2
      const albumPenalty = (albumCounts.get(candidate.albumId) ?? 0) * 0.36
      const adjustedScore = candidate.score - artistPenalty - albumPenalty
      if (adjustedScore > bestScore) {
        bestIndex = index
        bestScore = adjustedScore
      }
    }
    const [best] = remaining.splice(bestIndex, 1)
    if (!best) {
      break
    }
    selected.push(best)
    artistCounts.set(best.artistId, (artistCounts.get(best.artistId) ?? 0) + 1)
    albumCounts.set(best.albumId, (albumCounts.get(best.albumId) ?? 0) + 1)
  }

  return selected
}

function buildSummary(
  candidate: RecommendationCandidate,
  kind: RecommendationKind,
  reasons: RecommendationReason[],
  daysSincePlayed: number | null,
  daysSinceAdded: number | null,
): string {
  const favouriteArtist = reasons.find((reason) => reason.code === 'FAVOURITE_ARTIST')
  const favouriteGenre = reasons.find((reason) => reason.code === 'FAVOURITE_GENRE')
  if (kind === 'forgotten_favourites' && daysSincePlayed !== null) {
    return `You have not played ${candidate.artistName} in ${daysSincePlayed} days, despite ${candidate.playCount} previous plays.`
  }
  if (kind === 'recently_added' && daysSinceAdded !== null) {
    return `${candidate.albumTitle} joined your library ${daysSinceAdded} days ago and is ready for a proper listen.`
  }
  if (kind === 'hidden_gems' && candidate.playCount === 0) {
    return `${candidate.trackTitle} has been in your library but has not been played yet.`
  }
  if (favouriteArtist) {
    return `${candidate.artistName} fits one of the artists you return to most.`
  }
  if (favouriteGenre) {
    return `${candidate.trackTitle} matches your affinity for ${String(favouriteGenre.facts.genre)}.`
  }
  if ((candidate.rating ?? 0) >= 8) {
    return `You rated ${candidate.trackTitle} highly, making it a strong fit for this mix.`
  }
  return `${candidate.trackTitle} adds a considered change of pace from your own library.`
}

function normaliseAffinity(source: Map<string, number>): Map<string, number> {
  let maximum = 1
  for (const value of source.values()) maximum = Math.max(maximum, value)
  return new Map([...source.entries()].map(([key, value]) => [key, clamp(value / maximum, 0, 1)]))
}

function highestGenreAffinity(genres: string[], affinity: Map<string, number>): number {
  return Math.max(0, ...genres.map((genre) => affinity.get(genre.trim().toLocaleLowerCase()) ?? 0))
}

function normalisePlayCount(playCount: number, maximum: number): number {
  return clamp(Math.log1p(Math.max(0, playCount)) / Math.log1p(maximum), 0, 1)
}

function recencySignal(days: number | null, window: number): number {
  return days === null ? 0 : 1 - clamp(days / window, 0, 1)
}

function daysSince(value: string | null, now: Date): number | null {
  if (!value) {
    return null
  }
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    return null
  }
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 86_400_000))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
