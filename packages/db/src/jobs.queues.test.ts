import { beforeEach, describe, expect, it, vi } from 'vitest'

const boss = vi.hoisted(() => ({
  on: vi.fn(),
  start: vi.fn(async () => undefined),
  createQueue: vi.fn<(name: string, options: Record<string, unknown>) => Promise<void>>(async () => undefined),
}))

vi.mock('pg-boss', () => ({
  PgBoss: vi.fn(function PgBoss() {
    return boss
  }),
}))

const jobs = await import('./jobs.js')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('startJobQueue', () => {
  it('starts the queue, routes errors to the caller and creates every queue', async () => {
    const onError = vi.fn()
    const started = await jobs.startJobQueue('postgresql://musearr@localhost/musearr', onError)

    expect(started).toBe(boss)
    expect(boss.on).toHaveBeenCalledWith('error', onError)
    expect(boss.start).toHaveBeenCalledTimes(1)
    const names = boss.createQueue.mock.calls.map((call) => call[0])
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining([
        jobs.LIBRARY_SYNC_QUEUE,
        jobs.PLAYLIST_SYNC_QUEUE,
        jobs.RECONCILIATION_QUEUE,
        jobs.RECOMMENDATION_RUN_QUEUE,
        jobs.DAILY_BRIEF_QUEUE,
        jobs.PLAYLIST_GENERATION_QUEUE,
        jobs.PLAYLIST_ACQUISITION_QUEUE,
        jobs.PLAYLIST_PUBLISH_QUEUE,
        jobs.PLAYLIST_GENERATION_RECONCILE_QUEUE,
      ]),
    )
  })

  it('gives every queue a bounded retry count, a finite expiry and retention', async () => {
    await jobs.startJobQueue('postgresql://musearr@localhost/musearr', vi.fn())

    for (const [name, options] of boss.createQueue.mock.calls) {
      expect(options.retryLimit, `${name} retryLimit`).toBeGreaterThanOrEqual(1)
      expect(options.retryLimit, `${name} retryLimit`).toBeLessThanOrEqual(3)
      expect(options.expireInSeconds, `${name} expiry`).toBeGreaterThan(0)
      expect(options.retentionSeconds, `${name} retention`).toBeGreaterThan(0)
    }
  })

  it('backs retries off for every queue that retries more than once', async () => {
    await jobs.startJobQueue('postgresql://musearr@localhost/musearr', vi.fn())

    for (const [name, options] of boss.createQueue.mock.calls) {
      if ((options.retryLimit as number) > 1) expect(options.retryBackoff, `${name} backoff`).toBe(true)
    }
  })
})
