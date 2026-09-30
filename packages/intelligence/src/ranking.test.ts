import { describe, expect, it } from 'vitest'
import { rankRecommendations, type RecommendationCandidate } from './ranking.js'

const now = new Date('2026-08-05T12:00:00.000Z')

const candidates: RecommendationCandidate[] = [
  {
    trackId: 'radiohead-1',
    artistId: 'radiohead',
    artistName: 'Radiohead',
    albumId: 'ok-computer',
    albumTitle: 'OK Computer',
    trackTitle: 'Paranoid Android',
    genres: ['Alternative Rock'],
    addedAt: '2022-01-01T00:00:00.000Z',
    lastPlayedAt: '2026-08-04T12:00:00.000Z',
    rating: 9,
    playCount: 35,
  },
  {
    trackId: 'slowdive-1',
    artistId: 'slowdive',
    artistName: 'Slowdive',
    albumId: 'souvlaki',
    albumTitle: 'Souvlaki',
    trackTitle: 'When the Sun Hits',
    genres: ['Alternative Rock'],
    addedAt: '2022-01-01T00:00:00.000Z',
    lastPlayedAt: '2025-10-25T12:00:00.000Z',
    rating: 9,
    playCount: 18,
  },
  {
    trackId: 'slowdive-2',
    artistId: 'slowdive',
    artistName: 'Slowdive',
    albumId: 'souvlaki',
    albumTitle: 'Souvlaki',
    trackTitle: 'Alison',
    genres: ['Alternative Rock'],
    addedAt: '2022-01-01T00:00:00.000Z',
    lastPlayedAt: '2025-10-25T12:00:00.000Z',
    rating: 9,
    playCount: 17,
  },
  {
    trackId: 'new-1',
    artistId: 'new-artist',
    artistName: 'New Artist',
    albumId: 'new-album',
    albumTitle: 'New Album',
    trackTitle: 'First Listen',
    genres: ['Electronic'],
    addedAt: '2026-07-30T12:00:00.000Z',
    lastPlayedAt: null,
    rating: null,
    playCount: 0,
  },
]

describe('rankRecommendations', () => {
  it('handles candidate lists larger than the runtime argument limit', () => {
    const large = Array.from({ length: 200_000 }, (_, index) => ({
      ...candidates[0]!, trackId: `track-${index}`, artistId: `artist-${index}`, albumId: `album-${index}`,
      playCount: index % 12,
    }))
    expect(rankRecommendations(large, 'daily_mix', { limit: 5, now })).toHaveLength(5)
  })

  it('surfaces a long-unplayed, well-loved track as a forgotten favourite', () => {
    const ranked = rankRecommendations(candidates, 'forgotten_favourites', { limit: 10, now })

    expect(ranked[0]).toMatchObject({
      trackId: 'slowdive-1',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'FORGOTTEN_FAVOURITE' })]),
    })
    expect(ranked[0]?.summary).toContain('284 days')
  })

  it('does not place two tracks from the same album ahead of a similarly qualified alternative', () => {
    const ranked = rankRecommendations(candidates, 'daily_mix', { limit: 3, now })

    expect(ranked.map((recommendation) => recommendation.trackId)).toContain('new-1')
    expect(ranked.slice(0, 2).map((recommendation) => recommendation.trackId)).not.toEqual([
      'slowdive-1',
      'slowdive-2',
    ])
  })

  it('explains recently added, unheard tracks with source facts', () => {
    const ranked = rankRecommendations(candidates, 'recently_added', { limit: 5, now })

    expect(ranked).toEqual([
      expect.objectContaining({
        trackId: 'new-1',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'RECENTLY_ADDED', facts: { daysInLibrary: 6 } }),
          expect.objectContaining({ code: 'UNHEARD' }),
        ]),
      }),
    ])
  })
})
