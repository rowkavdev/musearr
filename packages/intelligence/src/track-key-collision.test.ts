import { expect, it } from 'vitest'
import { CompositeSimilarTrackProvider } from './similar.js'
import { generateFromSeed, type PlaylistLibraryTrack } from './playlist.js'

const first = { artistName: 'A::B', trackTitle: 'C', albumTitle: null, source: 'fixture' }
const second = { artistName: 'A', trackTitle: 'B::C', albumTitle: null, source: 'fixture' }
const seed: PlaylistLibraryTrack = {
  trackId: 'seed', plexRatingKey: '1', artistId: 'seed-artist', artistName: 'Seed',
  albumId: 'seed-album', albumTitle: 'Seed album', trackTitle: 'Seed track',
  genres: ['rock'], year: 2000, rating: null, playCount: 0, lastPlayedAt: null,
}

it('composite providers preserve distinct artist/title pairs containing the separator', async () => {
  const provider = new CompositeSimilarTrackProvider([
    { name: 'fixture', findSimilar: async () => [first, second, { ...first, artistName: ' a::b ', trackTitle: ' c ' }] },
  ])
  expect(await provider.findSimilar(seed, 5)).toEqual([first, second])
})

it('playlist gaps preserve distinct artist/title pairs and still deduplicate exact normalized pairs', () => {
  const plan = generateFromSeed(seed, [seed], {
    externalSuggestions: [first, second, { ...first, artistName: ' a::b ', trackTitle: ' c ' }],
  })
  expect(plan.gapCount).toBe(2)
  expect(plan.items.map(item => [item.artistName, item.trackTitle])).toEqual([
    ['A::B', 'C'], ['A', 'B::C'],
  ])
})

it('a different library pair cannot hide a missing external track via a separator collision', () => {
  const libraryTrack = { ...seed, ...first, albumTitle: 'Library album', trackId: 'library', plexRatingKey: '2', artistId: 'other' }
  const plan = generateFromSeed(seed, [seed, libraryTrack], { externalSuggestions: [first, second] })
  expect(plan.gapCount).toBe(1)
  expect(plan.items.filter(item => !item.inLibrary).map(item => [item.artistName, item.trackTitle])).toEqual([
    ['A', 'B::C'],
  ])
})
