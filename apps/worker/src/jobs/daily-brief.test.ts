import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  beginDiscordDailyBriefDelivery: vi.fn(),
  completeDiscordDailyBriefDelivery: vi.fn(),
  createDailyBrief: vi.fn(),
  deliverDiscordDailyBrief: vi.fn(),
  failDiscordDailyBriefDelivery: vi.fn(),
  generateRecommendationRun: vi.fn(),
  getDailyBriefDelivery: vi.fn(),
  getDailyBriefForDate: vi.fn(),
  getDashboardOverview: vi.fn(),
}))

vi.mock('@musearr/db', () => ({
  beginDiscordDailyBriefDelivery: mocks.beginDiscordDailyBriefDelivery,
  completeDiscordDailyBriefDelivery: mocks.completeDiscordDailyBriefDelivery,
  createDailyBrief: mocks.createDailyBrief,
  failDiscordDailyBriefDelivery: mocks.failDiscordDailyBriefDelivery,
  getDailyBriefDelivery: mocks.getDailyBriefDelivery,
  getDailyBriefForDate: mocks.getDailyBriefForDate,
  getDashboardOverview: mocks.getDashboardOverview,
}))
vi.mock('@musearr/integrations', () => ({
  DiscordDeliveryError: class DiscordDeliveryError extends Error {},
  deliverDiscordDailyBrief: mocks.deliverDiscordDailyBrief,
}))
vi.mock('./recommendation-run.js', () => ({ generateRecommendationRun: mocks.generateRecommendationRun }))

import { generateDailyBrief } from './daily-brief.js'

const database = {} as never
const overview = {
  library: { trackCount: 456, albumCount: 34, newestAddedAt: '2026-08-01T12:00:00.000Z' },
  listening: { totalPlayCount: 321, playedTrackCount: 87, ratedTrackCount: 19, lastPlayedAt: null },
  favourites: { artists: [{ id: 'artist', name: 'Slowdive', playCount: 42 }], genres: [] },
  sync: { status: 'completed' as const, lastCompletedAt: '2026-08-05T06:00:00.000Z', errorSummary: null },
  dailyMix: [
    {
      trackTitle: 'Alison',
      artistName: 'Slowdive',
      summary: 'You have not played Slowdive in 284 days, despite 42 previous plays.',
    },
  ],
}
const savedBrief = {
  id: 'c6fef068-8fc1-4347-b0a6-a1eea8e92a5a',
  briefDate: '2026-08-05',
  timezone: 'Europe/London',
  algorithmVersion: '2026-08-05.1',
  content: { headline: 'A thoughtful place to begin.', summary: 'Today’s Daily Mix starts with Alison by Slowdive.', cards: [{ kind: 'sync' as const, title: 'Current', body: 'Fresh.' }] },
  createdAt: '2026-08-05T07:30:00.000Z',
  discordDelivery: null,
}

describe('daily briefing job', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates one deterministic daily snapshot after refreshing the Daily Mix', async () => {
    mocks.getDailyBriefForDate.mockResolvedValue(null)
    mocks.generateRecommendationRun.mockResolvedValue({ runId: 'mix', recommendationCount: 20 })
    mocks.getDashboardOverview.mockResolvedValue(overview)
    mocks.createDailyBrief.mockResolvedValue(savedBrief)

    const result = await generateDailyBrief(database, 'owner-id', {
      timezone: 'Europe/London',
      now: new Date('2026-08-05T07:30:00.000Z'),
    })

    expect(mocks.generateRecommendationRun).toHaveBeenCalledWith(database, 'owner-id', 'daily_mix', 20)
    expect(mocks.createDailyBrief).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ briefDate: '2026-08-05', timezone: 'Europe/London' }),
    )
    expect(result).toMatchObject({ created: true, delivered: false, brief: savedBrief })
  })

  it('does not regenerate or re-deliver a briefing already confirmed by Discord', async () => {
    mocks.getDailyBriefForDate.mockResolvedValue(savedBrief)
    mocks.getDailyBriefDelivery.mockResolvedValue({ status: 'delivered' })

    const result = await generateDailyBrief(database, 'owner-id', {
      timezone: 'Europe/London',
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
      now: new Date('2026-08-05T07:30:00.000Z'),
    })

    expect(mocks.generateRecommendationRun).not.toHaveBeenCalled()
    expect(mocks.deliverDiscordDailyBrief).not.toHaveBeenCalled()
    expect(result).toMatchObject({ created: false, delivered: true })
  })

  it('retries recording a delivery that already reached Discord instead of marking it failed', async () => {
    mocks.getDailyBriefForDate.mockResolvedValue(savedBrief)
    mocks.getDailyBriefDelivery.mockResolvedValue(null)
    mocks.deliverDiscordDailyBrief.mockResolvedValue(undefined)
    mocks.completeDiscordDailyBriefDelivery.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined)

    const result = await generateDailyBrief(database, 'owner-id', {
      timezone: 'Europe/London',
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
      now: new Date('2026-08-05T07:30:00.000Z'),
    })

    expect(mocks.deliverDiscordDailyBrief).toHaveBeenCalledTimes(1)
    expect(mocks.completeDiscordDailyBriefDelivery).toHaveBeenCalledTimes(2)
    expect(mocks.failDiscordDailyBriefDelivery).not.toHaveBeenCalled()
    expect(result).toMatchObject({ delivered: true })
  })
})
