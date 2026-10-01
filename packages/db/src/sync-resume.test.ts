import { describe, expect, it } from 'vitest'
import type { Database } from './repository.js'
import { getResumableSyncProgress, resumableProgressFromRun } from './repository.js'

const failedRun = {
  status: 'failed',
  error_summary: 'upstream_unavailable: Plex is temporarily unavailable.',
  cursor: { offset: 400 },
  counts: { importedTracks: 395, skippedTracks: 5 },
  recent: true,
}

describe('resumableProgressFromRun', () => {
  it.each(['upstream_unavailable', 'upstream_response', 'unknown'])('resumes after a recent %s failure', (classification) => {
    expect(resumableProgressFromRun({ ...failedRun, error_summary: `${classification}: summary` })).toEqual({
      offset: 400,
      importedTracks: 395,
      skippedTracks: 5,
    })
  })

  it.each(['configuration', 'authentication'])('starts fresh after a non-retryable %s failure', (classification) => {
    expect(resumableProgressFromRun({ ...failedRun, error_summary: `${classification}: summary` })).toBeNull()
  })

  it('starts fresh after a completed or running run', () => {
    expect(resumableProgressFromRun({ ...failedRun, status: 'completed' })).toBeNull()
    expect(resumableProgressFromRun({ ...failedRun, status: 'running' })).toBeNull()
  })

  it('starts fresh when there is no previous run, it is stale, or it saved no progress', () => {
    expect(resumableProgressFromRun(undefined)).toBeNull()
    expect(resumableProgressFromRun({ ...failedRun, recent: false })).toBeNull()
    expect(resumableProgressFromRun({ ...failedRun, cursor: { offset: 0 } })).toBeNull()
    expect(resumableProgressFromRun({ ...failedRun, cursor: {} })).toBeNull()
    expect(resumableProgressFromRun({ ...failedRun, error_summary: null })).toBeNull()
  })

  it('ignores malformed counts rather than carrying garbage forward', () => {
    expect(resumableProgressFromRun({ ...failedRun, counts: { importedTracks: -3, skippedTracks: 'x' } })).toEqual({
      offset: 400,
      importedTracks: 0,
      skippedTracks: 0,
    })
  })
})

describe('getResumableSyncProgress', () => {
  it('closes orphaned running runs before reading the latest run', async () => {
    const statements: string[] = []
    const database = (async (strings: TemplateStringsArray) => {
      const statement = strings.join('?')
      statements.push(statement)
      if (statement.includes('SELECT status')) {
        return [{ ...failedRun, cursor: { offset: 400 } }]
      }
      return []
    }) as unknown as Database

    await expect(getResumableSyncProgress(database, 'section-1')).resolves.toEqual({
      offset: 400,
      importedTracks: 395,
      skippedTracks: 5,
    })
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('UPDATE sync_runs')
    expect(statements[0]).toContain("status = 'running'")
    expect(statements[1]).toContain('SELECT status')
  })
})
