import { describe, expect, it } from 'vitest'
import { buildDailyBrief, localDateInTimeZone } from './daily-brief.js'

describe('daily briefing', () => {
  it('uses the configured timezone when choosing a durable local briefing date', () => {
    const now = new Date('2026-08-05T00:30:00.000Z')
    expect(localDateInTimeZone('America/Los_Angeles', now)).toBe('2026-08-04')
    expect(localDateInTimeZone('Europe/London', now)).toBe('2026-08-05')
  })

  it('creates a factual, explainable briefing from a persisted local snapshot', () => {
    const brief = buildDailyBrief({
      library: { trackCount: 456, albumCount: 34, newestAddedAt: '2026-08-01T12:00:00.000Z' },
      listening: { totalPlayCount: 321, lastPlayedAt: '2026-08-04T19:30:00.000Z' },
      favourites: {
        artists: [{ name: 'Slowdive', playCount: 42 }],
        genres: [{ name: 'Dream pop', playCount: 58 }],
      },
      sync: { status: 'completed', lastCompletedAt: '2026-08-05T06:00:00.000Z', errorSummary: null },
      dailyMix: [
        {
          trackTitle: 'Alison',
          artistName: 'Slowdive',
          summary: 'You have not played Alison by Slowdive in 284 days, despite 42 previous plays.',
        },
      ],
    })

    expect(brief).toMatchObject({
      headline: 'A thoughtful place to begin.',
      summary: 'Today’s Daily Mix starts with Alison by Slowdive.',
    })
    expect(brief.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'daily_mix', title: 'Start with Alison' }),
        expect.objectContaining({ kind: 'favourite_artist', title: 'Slowdive is still close' }),
        expect.objectContaining({ kind: 'sync', title: 'Your local mirror is current' }),
      ]),
    )
  })

  it('does not invent listening insight while a first library import is empty', () => {
    const brief = buildDailyBrief({
      library: { trackCount: 0, albumCount: 0, newestAddedAt: null },
      listening: { totalPlayCount: 0, lastPlayedAt: null },
      favourites: { artists: [], genres: [] },
      sync: { status: 'queued', lastCompletedAt: null, errorSummary: null },
      dailyMix: [],
    })

    expect(brief.cards).toEqual([
      expect.objectContaining({ kind: 'sync', title: 'Your library is updating' }),
    ])
  })
})
