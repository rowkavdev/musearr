import { describe, expect, it } from 'vitest'
import { generateFromSeed, type PlaylistLibraryTrack } from './playlist.js'

function track(overrides: Partial<PlaylistLibraryTrack> & Pick<PlaylistLibraryTrack, 'trackId'>): PlaylistLibraryTrack {
  return {
    plexRatingKey: `rk-${overrides.trackId}`,
    artistId: 'artist-a',
    artistName: 'Artist A',
    albumId: `album-${overrides.trackId}`,
    albumTitle: 'An Album',
    trackTitle: `Track ${overrides.trackId}`,
    genres: ['Shoegaze'],
    year: 1993,
    rating: null,
    playCount: 0,
    lastPlayedAt: null,
    ...overrides,
  }
}

const seed = track({
  trackId: 'seed',
  artistId: 'slowdive',
  artistName: 'Slowdive',
  albumId: 'souvlaki',
  trackTitle: 'Alison',
  genres: ['Shoegaze', 'Dream Pop'],
  year: 1993,
})

describe('generateFromSeed', () => {
  it('handles a library larger than the runtime argument limit', () => {
    const library = Array.from({ length: 200_000 }, (_, index) =>
      index === 0 ? seed : track({ trackId: `t-${index}`, albumId: `album-${index}`, playCount: index % 12 }),
    )
    const plan = generateFromSeed(seed, library, { targetSize: 5 })
    expect(plan.items.length).toBeGreaterThan(0)
  })

  it('orders library tracks by fit and keeps the plan anchored to the seed', () => {
    const library = [
      seed,
      track({ trackId: 'ride-1', artistId: 'ride', artistName: 'Ride', albumId: 'nowhere', genres: ['Shoegaze'], year: 1990 }),
      track({ trackId: 'unrelated', artistId: 'metallica', artistName: 'Metallica', albumId: 'black', genres: ['Thrash Metal'], year: 1991 }),
    ]

    const plan = generateFromSeed(seed, library, { targetSize: 10 })

    const ids = plan.items.map((item) => item.trackId)
    expect(ids).toContain('ride-1')
    expect(ids).not.toContain('unrelated')
    expect(ids).not.toContain('seed')
    expect(plan.items.every((item) => item.inLibrary)).toBe(true)
  })

  it('is deterministic for identical inputs', () => {
    const library = [
      seed,
      track({ trackId: 'a', artistId: 'ride', albumId: 'a', genres: ['Shoegaze'] }),
      track({ trackId: 'b', artistId: 'lush', albumId: 'b', genres: ['Dream Pop'] }),
      track({ trackId: 'c', artistId: 'chapterhouse', albumId: 'c', genres: ['Shoegaze'] }),
    ]

    expect(generateFromSeed(seed, library, { targetSize: 5 })).toEqual(
      generateFromSeed(seed, library, { targetSize: 5 }),
    )
  })

  it('caps tracks per album and per non-seed artist', () => {
    const library = [
      seed,
      track({ trackId: 'ride-1', artistId: 'ride', albumId: 'nowhere', genres: ['Shoegaze'] }),
      track({ trackId: 'ride-2', artistId: 'ride', albumId: 'nowhere', genres: ['Shoegaze'] }),
      track({ trackId: 'ride-3', artistId: 'ride', albumId: 'going-blank', genres: ['Shoegaze'] }),
      track({ trackId: 'ride-4', artistId: 'ride', albumId: 'tarantula', genres: ['Shoegaze'] }),
    ]

    const plan = generateFromSeed(seed, library, { targetSize: 10 })
    const rideItems = plan.items.filter((item) => item.artistName === 'Artist A')
    expect(rideItems.length).toBeLessThanOrEqual(2)
    expect(new Set(plan.items.map((item) => item.trackTitle)).size).toBe(plan.items.length)
  })

  it('appends external suggestions as gap items only when the library cannot fill the target', () => {
    const library = [
      seed,
      track({ trackId: 'ride-1', artistId: 'ride', artistName: 'Ride', albumId: 'nowhere', genres: ['Shoegaze'] }),
    ]

    const plan = generateFromSeed(seed, library, {
      targetSize: 5,
      externalSuggestions: [
        { artistName: 'Ride', trackTitle: 'Track ride-1', albumTitle: null, source: 'test' }, // already present
        { artistName: 'Chapterhouse', trackTitle: 'Pearl', albumTitle: 'Whirlpool', source: 'test' },
      ],
    })

    const gaps = plan.items.filter((item) => !item.inLibrary)
    expect(plan.gapCount).toBe(1)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ artistName: 'Chapterhouse', trackTitle: 'Pearl', trackId: null })
    expect(gaps[0]?.position).toBe(plan.inLibraryCount)
  })
})
