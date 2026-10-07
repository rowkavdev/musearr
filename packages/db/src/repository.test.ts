import { describe, expect, it, vi } from 'vitest'
import { getDashboardOverview, getLatestDailyBrief, getListeningInsightSummary, type Database } from './repository.js'

describe('getDashboardOverview', () => {
  it('returns a stable, locally-derived dashboard summary with persisted Daily Mix reasons', async () => {
    const database = (async (strings: TemplateStringsArray) => {
      const query = strings.join(' ')
      if (query.includes('COUNT(DISTINCT artist.id)')) {
        return [
          {
            artist_count: '12',
            album_count: '34',
            track_count: '456',
            total_duration_ms: '1234567',
            newest_added_at: new Date('2026-08-01T12:00:00.000Z'),
          },
        ]
      }
      if (query.includes('COUNT(*) FILTER (WHERE play_count > 0)')) {
        return [
          {
            total_play_count: '321',
            played_track_count: '87',
            rated_track_count: '19',
            last_played_at: new Date('2026-08-04T19:30:00.000Z'),
          },
        ]
      }
      if (query.includes('GROUP BY artist.id')) {
        return [
          {
            id: 'f9bbd5e7-bd67-4ae7-afc5-358f232b5b4b',
            name: 'Slowdive',
            play_count: '42',
          },
        ]
      }
      if (query.includes('GROUP BY genre.id')) {
        return [
          {
            id: 'a062ecb4-bb5c-46cd-8b29-8a53c06cb984',
            name: 'Dream pop',
            play_count: '58',
          },
        ]
      }
      if (query.includes('UPDATE sync_runs')) {
        return []
      }
      if (query.includes('FROM sync_runs')) {
        return [
          {
            status: 'completed',
            finished_at: new Date('2026-08-05T06:00:00.000Z'),
            error_summary: null,
          },
        ]
      }
      if (query.includes('WITH latest_runs')) {
        return [
          {
            run_id: 'cbf0f2e2-89e8-485a-9106-cf82f12cfd0f',
            kind: 'daily_mix',
            algorithm_version: '2026-08-05.2',
            created_at: new Date('2026-08-05T07:00:00.000Z'),
            track_id: '667d8641-c6ca-459c-80c6-759fdc592c4a',
            track_title: 'Alison',
            artist_name: 'Slowdive',
            album_title: 'Souvlaki',
            rank: 1,
            score: '0.82',
            reason_codes: [{ code: 'FORGOTTEN_FAVOURITE', weight: 0.82 }],
            explanation_data: {
              summary: 'You have not played Slowdive in 284 days.',
            },
          },
        ]
      }
      throw new Error(`Unexpected query: ${query}`)
    }) as unknown as Database

    await expect(getDashboardOverview(database, '723afeb4-f660-42ef-8963-f4a42ecbb9e2')).resolves.toEqual({
      library: {
        artistCount: 12,
        albumCount: 34,
        trackCount: 456,
        totalDurationMs: 1_234_567,
        newestAddedAt: '2026-08-01T12:00:00.000Z',
      },
      listening: {
        totalPlayCount: 321,
        playedTrackCount: 87,
        ratedTrackCount: 19,
        lastPlayedAt: '2026-08-04T19:30:00.000Z',
      },
      favourites: {
        artists: [
          {
            id: 'f9bbd5e7-bd67-4ae7-afc5-358f232b5b4b',
            name: 'Slowdive',
            playCount: 42,
          },
        ],
        genres: [
          {
            id: 'a062ecb4-bb5c-46cd-8b29-8a53c06cb984',
            name: 'Dream pop',
            playCount: 58,
          },
        ],
      },
      sync: {
        status: 'completed',
        lastCompletedAt: '2026-08-05T06:00:00.000Z',
        errorSummary: null,
      },
      dailyMix: [
        {
          runId: 'cbf0f2e2-89e8-485a-9106-cf82f12cfd0f',
          kind: 'daily_mix',
          algorithmVersion: '2026-08-05.2',
          createdAt: '2026-08-05T07:00:00.000Z',
          trackId: '667d8641-c6ca-459c-80c6-759fdc592c4a',
          trackTitle: 'Alison',
          artistName: 'Slowdive',
          albumTitle: 'Souvlaki',
          rank: 1,
          score: 0.82,
          reasons: [{ code: 'FORGOTTEN_FAVOURITE', weight: 0.82 }],
          summary: 'You have not played Slowdive in 284 days.',
        },
      ],
    })
  })
})

describe('getLatestDailyBrief', () => {
  it('returns the immutable briefing snapshot with observable Discord delivery state', async () => {
    const database = (async () => [
      {
        id: 'c6fef068-8fc1-4347-b0a6-a1eea8e92a5a',
        brief_date: '2026-08-05',
        timezone: 'Europe/London',
        algorithm_version: '2026-08-05.1',
        content: {
          headline: 'A thoughtful place to begin.',
          summary: 'Today’s Daily Mix starts with Alison by Slowdive.',
          cards: [
            {
              kind: 'daily_mix',
              title: 'Start with Alison',
              body: 'Slowdive — a rediscovery.',
            },
          ],
        },
        created_at: new Date('2026-08-05T07:30:00.000Z'),
        delivery_status: 'delivered',
        delivery_attempt_count: '1',
        delivery_last_attempt_at: new Date('2026-08-05T07:30:01.000Z'),
        delivery_delivered_at: new Date('2026-08-05T07:30:02.000Z'),
        delivery_error_summary: null,
      },
    ]) as unknown as Database

    await expect(getLatestDailyBrief(database, '723afeb4-f660-42ef-8963-f4a42ecbb9e2')).resolves.toEqual({
      id: 'c6fef068-8fc1-4347-b0a6-a1eea8e92a5a',
      briefDate: '2026-08-05',
      timezone: 'Europe/London',
      algorithmVersion: '2026-08-05.1',
      content: {
        headline: 'A thoughtful place to begin.',
        summary: 'Today’s Daily Mix starts with Alison by Slowdive.',
        cards: [
          {
            kind: 'daily_mix',
            title: 'Start with Alison',
            body: 'Slowdive — a rediscovery.',
          },
        ],
      },
      createdAt: '2026-08-05T07:30:00.000Z',
      discordDelivery: {
        status: 'delivered',
        attemptCount: 1,
        lastAttemptAt: '2026-08-05T07:30:01.000Z',
        deliveredAt: '2026-08-05T07:30:02.000Z',
        errorSummary: null,
      },
    })
  })
})

describe('getListeningInsightSummary', () => {
  it('keeps exact and observed playback provenance separate in a user-local period', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T23:30:00.000Z'))
    try {
      const database = (async (strings: TemplateStringsArray) => {
        const query = strings.join(' ')
        if (query.includes('SUM(track_rollup.reported_plays)')) {
          return [
            {
              reported_plays: '12',
              exact_plays: '7',
              observed_plays: '5',
              estimated_listened_ms: '2520000',
              unique_tracks: '8',
              unique_artists: '3',
            },
          ]
        }
        if (query.includes('FROM user_artist_rollups rollup')) {
          return [
            {
              id: 'f9bbd5e7-bd67-4ae7-afc5-358f232b5b4b',
              name: 'Slowdive',
              play_count: '6',
            },
          ]
        }
        throw new Error(`Unexpected query: ${query}`)
      }) as unknown as Database

      await expect(
        getListeningInsightSummary(database, '723afeb4-f660-42ef-8963-f4a42ecbb9e2', 'Europe/London', 7),
      ).resolves.toEqual({
        period: {
          startDate: '2026-07-31',
          endDate: '2026-08-06',
          timezone: 'Europe/London',
        },
        playback: {
          reportedPlays: 12,
          exactPlays: 7,
          observedPlays: 5,
          estimatedListenedMs: 2_520_000,
          uniqueTracks: 8,
          uniqueArtists: 3,
          coverage: 'mixed',
        },
        topArtists: [
          {
            id: 'f9bbd5e7-bd67-4ae7-afc5-358f232b5b4b',
            name: 'Slowdive',
            playCount: 6,
          },
        ],
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
