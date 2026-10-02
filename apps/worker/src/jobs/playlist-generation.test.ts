import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getPlaylistGenerationJobContext: vi.fn(),
  getPlaylistLibraryTracks: vi.fn(),
  replacePlaylistGenerationItems: vi.fn<(database: unknown, id: string, items: unknown[], version: string) => Promise<void>>(async () => undefined),
  setPlaylistGenerationStatus: vi.fn(async () => undefined),
}))

vi.mock('@musearr/db', () => db)

const { generatePlaylist } = await import('./playlist-generation.js')

const database = {} as never
// Only the fields the generator reads: AI and MusicBrainz stay off so no network is touched.
const config = {
  MUSEARR_MUSICBRAINZ_ENABLED: false,
  MUSEARR_LOCAL_AI_ENABLED: false,
} as never

function track(id: string, overrides: Record<string, unknown> = {}) {
  return {
    trackId: id,
    plexRatingKey: `rk-${id}`,
    artistId: `artist-${id}`,
    artistName: `Artist ${id}`,
    albumId: `album-${id}`,
    albumTitle: `Album ${id}`,
    trackTitle: `Track ${id}`,
    genres: ['rock'],
    year: 1999,
    rating: null,
    playCount: 1,
    lastPlayedAt: null,
    ...overrides,
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Late Night',
    seedTrackId: 'seed',
    targetSize: 10,
    acquireMissing: false,
    publishToPlex: true,
    status: 'queued',
    userId: 'user-1',
    plexPlaylistRatingKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getPlaylistGenerationJobContext.mockResolvedValue(context())
  db.getPlaylistLibraryTracks.mockResolvedValue([track('seed'), track('a'), track('b'), track('c')])
})

describe('generatePlaylist', () => {
  it('stores the planned items and hands off to publish when the library has matches', async () => {
    const outcome = await generatePlaylist(database, config, 'gen-1')

    expect(outcome).toMatchObject({ next: 'publish', gaps: 0 })
    expect(outcome.inLibrary).toBeGreaterThan(0)
    const items = db.replacePlaylistGenerationItems.mock.calls[0]![2] as unknown as Array<{ trackId: string | null; state: string; position: number }>
    expect(items.map((item) => item.trackId)).not.toContain('seed')
    expect(items.every((item) => item.state === 'in_library')).toBe(true)
    expect(db.setPlaylistGenerationStatus).toHaveBeenLastCalledWith(database, 'gen-1', 'ready')
  })

  it('finishes without publishing when the owner turned publishing off', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context({ publishToPlex: false }))

    const outcome = await generatePlaylist(database, config, 'gen-1')

    expect(outcome.next).toBe('done')
    expect(db.setPlaylistGenerationStatus).toHaveBeenLastCalledWith(database, 'gen-1', 'ready')
  })

  it('does not publish an empty playlist', async () => {
    db.getPlaylistLibraryTracks.mockResolvedValue([track('seed')])

    const outcome = await generatePlaylist(database, config, 'gen-1')

    expect(outcome).toEqual({ inLibrary: 0, gaps: 0, next: 'done' })
  })

  it('fails clearly when the generation was deleted', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(null)
    await expect(generatePlaylist(database, config, 'gen-1')).rejects.toThrow('no longer exists')
    expect(db.replacePlaylistGenerationItems).not.toHaveBeenCalled()
  })

  it('fails clearly when the seed track is gone from the context or the library', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context({ seedTrackId: null }))
    await expect(generatePlaylist(database, config, 'gen-1')).rejects.toThrow('seed track is no longer')

    db.getPlaylistGenerationJobContext.mockResolvedValue(context({ seedTrackId: 'missing' }))
    await expect(generatePlaylist(database, config, 'gen-1')).rejects.toThrow('seed track is no longer')
    expect(db.replacePlaylistGenerationItems).not.toHaveBeenCalled()
  })
})
