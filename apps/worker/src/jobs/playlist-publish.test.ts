import { randomBytes } from 'node:crypto'
import { encryptSecret } from '@musearr/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getGenerationItemStateCounts: vi.fn(),
  getLibrarySyncSources: vi.fn(),
  getPlaylistGenerationJobContext: vi.fn(),
  getPublishableGenerationItems: vi.fn(),
  linkManagedPlexPlaylist: vi.fn(async () => 'playlist-row-1'),
  markGenerationItemsPublished: vi.fn(async () => undefined),
  recordPlaylistPublication: vi.fn(async () => undefined),
  setPlaylistGenerationStatus: vi.fn(async () => undefined),
}))

const plex = vi.hoisted(() => ({
  findAudioPlaylistByTitle: vi.fn(),
  createAudioPlaylist: vi.fn(),
  addPlaylistItems: vi.fn(async () => undefined),
  playlistItems: vi.fn(async (): Promise<{ total: number; offset: number; scanned: number; items: Array<{ plexTrackRatingKey: string; addedAt: string | null }>; skipped: number }> => ({ total: 0, offset: 0, scanned: 0, items: [], skipped: 0 })),
}))

vi.mock('@musearr/db', () => db)
vi.mock('@musearr/plex', () => ({
  PlexClient: vi.fn(function PlexClient() {
    return plex
  }),
}))

const { publishPlaylistToPlex } = await import('./playlist-publish.js')

const encryptionKey = randomBytes(32).toString('base64')
const config = { MUSEARR_ENCRYPTION_KEY: encryptionKey } as never
const database = {} as never

function context(overrides: Record<string, unknown> = {}) {
  return { name: 'Late Night', publishToPlex: true, plexPlaylistRatingKey: null, status: 'ready', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getLibrarySyncSources.mockResolvedValue([
    {
      plexServerId: 'server-1',
      machineIdentifier: 'machine-1',
      librarySectionId: 'section-row-1',
      plexSectionId: '4',
      serverName: 'Test Plex',
      baseUrl: 'http://plex.local:32400',
      tokenCiphertext: encryptSecret('test-token', encryptionKey),
      ownerUserId: 'user-1',
      ownerTimezone: 'Europe/London',
    },
  ])
  db.getPublishableGenerationItems.mockResolvedValue([
    { id: 'item-1', plexRatingKey: '1001' },
    { id: 'item-2', plexRatingKey: '1002' },
  ])
  db.getGenerationItemStateCounts.mockResolvedValue({
    pending: 0,
    requested: 0,
    downloading: 0,
    imported: 0,
    unavailable: 0,
  })
  plex.findAudioPlaylistByTitle.mockResolvedValue(null)
  plex.createAudioPlaylist.mockResolvedValue({ plexRatingKey: '9001', title: 'Late Night' })
})

describe('publishPlaylistToPlex', () => {
  it('does nothing in Plex when publishing is off for the generation', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context({ publishToPlex: false }))

    const outcome = await publishPlaylistToPlex(database, config, 'gen-1')

    expect(outcome).toEqual({ created: false, added: 0, status: 'ready' })
    expect(plex.createAudioPlaylist).not.toHaveBeenCalled()
    expect(plex.addPlaylistItems).not.toHaveBeenCalled()
    expect(db.linkManagedPlexPlaylist).not.toHaveBeenCalled()
  })

  it('creates and links a Musearr-managed playlist on first publish', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context())

    const outcome = await publishPlaylistToPlex(database, config, 'gen-1')

    expect(plex.createAudioPlaylist).toHaveBeenCalledWith('machine-1', 'Late Night', ['1001', '1002'])
    expect(db.linkManagedPlexPlaylist).toHaveBeenCalledWith(database, {
      generationId: 'gen-1',
      plexServerId: 'server-1',
      plexRatingKey: '9001',
      name: 'Late Night',
    })
    expect(db.markGenerationItemsPublished).toHaveBeenCalledWith(database, ['item-1', 'item-2'])
    expect(outcome).toEqual({ created: true, added: 2, status: 'published' })
  })

  it("does not hijack a user's same-named playlist", async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context())
    plex.findAudioPlaylistByTitle.mockImplementation(async (title: string) =>
      title === 'Late Night' ? { plexRatingKey: 'user-playlist-99', title } : null,
    )

    const outcome = await publishPlaylistToPlex(database, config, 'gen-1')

    expect(plex.addPlaylistItems).not.toHaveBeenCalled()
    expect(plex.createAudioPlaylist).toHaveBeenCalledWith('machine-1', 'Late Night (Musearr)', ['1001', '1002'])
    expect(db.linkManagedPlexPlaylist).toHaveBeenCalledWith(database, {
      generationId: 'gen-1', plexServerId: 'server-1', plexRatingKey: '9001', name: 'Late Night (Musearr)',
    })
    expect(outcome).toEqual({ created: true, added: 2, status: 'published' })
  })

  it('does not reuse a colliding Musearr suffix either', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context())
    plex.findAudioPlaylistByTitle.mockImplementation(async (title: string) =>
      title === 'Late Night' || title === 'Late Night (Musearr)' ? { plexRatingKey: `other-${title}`, title } : null,
    )

    await publishPlaylistToPlex(database, config, 'gen-1')

    expect(plex.createAudioPlaylist).toHaveBeenCalledWith('machine-1', 'Late Night (Musearr 2)', ['1001', '1002'])
    expect(plex.addPlaylistItems).not.toHaveBeenCalled()
  })

  it('only appends new items to the playlist it already owns on re-publish', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context({ plexPlaylistRatingKey: '9001', status: 'published' }))
    db.getPublishableGenerationItems.mockResolvedValue([{ id: 'item-3', plexRatingKey: '1003' }])

    const outcome = await publishPlaylistToPlex(database, config, 'gen-1')

    expect(plex.findAudioPlaylistByTitle).not.toHaveBeenCalled()
    expect(plex.createAudioPlaylist).not.toHaveBeenCalled()
    expect(plex.addPlaylistItems).toHaveBeenCalledWith('9001', 'machine-1', ['1003'])
    expect(db.linkManagedPlexPlaylist).not.toHaveBeenCalled()
    expect(outcome).toEqual({ created: false, added: 1, status: 'published' })
  })

  it('#97 does not re-add tracks already in the Plex playlist after a failed bookkeeping write', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context({ plexPlaylistRatingKey: '9001', status: 'publishing' }))
    db.getPublishableGenerationItems.mockResolvedValue([
      { id: 'item-1', plexRatingKey: '1001' },
      { id: 'item-2', plexRatingKey: '1002' },
    ])
    plex.playlistItems.mockResolvedValueOnce({
      total: 1,
      offset: 0,
      scanned: 1,
      items: [{ plexTrackRatingKey: '1001', addedAt: null }],
      skipped: 0,
    })

    await publishPlaylistToPlex(database, config, 'gen-1')

    expect(plex.addPlaylistItems).toHaveBeenCalledWith('9001', 'machine-1', ['1002'])
    expect(db.markGenerationItemsPublished).toHaveBeenCalledWith(database, ['item-1', 'item-2'])
  })

  it('makes no Plex writes when a re-publish has nothing new', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context({ plexPlaylistRatingKey: '9001', status: 'published' }))
    db.getPublishableGenerationItems.mockResolvedValue([])

    const outcome = await publishPlaylistToPlex(database, config, 'gen-1')

    expect(plex.addPlaylistItems).not.toHaveBeenCalled()
    expect(plex.createAudioPlaylist).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ created: false, added: 0 })
  })

  it('does not create an empty playlist', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context())
    db.getPublishableGenerationItems.mockResolvedValue([])

    const outcome = await publishPlaylistToPlex(database, config, 'gen-1')

    expect(plex.createAudioPlaylist).not.toHaveBeenCalled()
    expect(outcome).toEqual({ created: false, added: 0, status: 'ready' })
  })

  it('records a failed publication and leaves items unpublished when Plex errors', async () => {
    db.getPlaylistGenerationJobContext.mockResolvedValue(context())
    plex.createAudioPlaylist.mockRejectedValue(new Error('Musearr could not reach the Plex server.'))

    await expect(publishPlaylistToPlex(database, config, 'gen-1')).rejects.toThrow()

    expect(db.recordPlaylistPublication).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ status: 'failed', publishedItemCount: 0 }),
    )
    expect(db.markGenerationItemsPublished).not.toHaveBeenCalled()
    expect(db.linkManagedPlexPlaylist).not.toHaveBeenCalled()
  })
})
