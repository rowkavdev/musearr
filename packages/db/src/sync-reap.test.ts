import { describe, expect, it } from 'vitest'
import {
  getResumableSyncProgress,
  INTERRUPTED_SYNC_SUMMARY,
  listSyncRuns,
  reapStaleSyncRuns,
  resumableProgressFromRun,
  STALE_SYNC_RUN_HOURS,
  type Database,
} from './repository.js'


function recordingDatabase() {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const database = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values })
    return Promise.resolve([])
  }) as unknown as Database
  return { database, calls }
}

describe('reapStaleSyncRuns', () => {
  it('fails running rows older than the threshold with a retryable classification', async () => {
    const { database, calls } = recordingDatabase()
    await reapStaleSyncRuns(database)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain("SET status = 'failed'")
    expect(calls[0]?.sql).toContain("WHERE status = 'running'")
    expect(calls[0]?.values).toEqual([INTERRUPTED_SYNC_SUMMARY, STALE_SYNC_RUN_HOURS])
  })

  it('produces a summary that the resume path treats as resumable', () => {
    expect(
      resumableProgressFromRun({
        status: 'failed',
        error_summary: INTERRUPTED_SYNC_SUMMARY,
        cursor: { offset: 950 },
        counts: { importedTracks: 940, skippedTracks: 10 },
        recent: true,
      }),
    ).toEqual({ offset: 950, importedTracks: 940, skippedTracks: 10 })
  })

  it('runs before listing runs and before reading resumable progress', async () => {
    const list = recordingDatabase()
    await listSyncRuns(list.database)
    expect(list.calls[0]?.sql).toContain('UPDATE sync_runs')

    const resume = recordingDatabase()
    await getResumableSyncProgress(resume.database, 'section-1')
    expect(resume.calls[0]?.sql).toContain('UPDATE sync_runs')
  })
})
