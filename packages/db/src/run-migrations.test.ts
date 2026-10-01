import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './run-migrations.js'

// A recording stand-in for the postgres client. reserve() hands back one
// pinned connection that logs each statement, plus begin() for transactions.
function fakeClient({ applied = [] as string[], lockAnswers = [true] as boolean[], failRun = false } = {}) {
  const events: string[] = []
  let released = 0
  let reserved = 0
  const answers = [...lockAnswers]
  const connection = (async (strings: TemplateStringsArray) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim()
    events.push(sql)
    if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ locked: answers.length > 1 ? answers.shift() : answers[0] }]
    return sql.startsWith('SELECT name FROM') ? applied.map((name) => ({ name })) : []
  }) as unknown as Record<string, unknown> & ((strings: TemplateStringsArray) => Promise<unknown[]>)
  connection.unsafe = async (source: string) => { events.push(source === 'BEGIN' || source === 'COMMIT' || source === 'ROLLBACK' ? source : `run ${source}`); if (failRun && source !== 'BEGIN' && source !== 'ROLLBACK') throw new Error('boom') }
  connection.release = () => { released += 1 }
  const client = { reserve: async () => { reserved += 1; return connection } } as unknown as Parameters<typeof runMigrations>[0]
  return { client, connection, events, counts: () => ({ reserved, released }) }
}

async function migrationDir(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'musearr-migrations-'))
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source)
  return directory
}

const quiet = () => undefined

describe('runMigrations', () => {
  it('locks one reserved connection before touching anything, then unlocks and releases it', async () => {
    const directory = await migrationDir({ '0001_a.sql': 'SELECT 1;' })
    const { client, events, counts } = fakeClient()
    await runMigrations(client, directory, quiet)
    expect(events[0]).toBe('SELECT pg_try_advisory_lock(?) AS locked')
    expect(events.at(-1)).toBe('SELECT pg_advisory_unlock(?)')
    expect(events.findIndex((event) => event.startsWith('CREATE TABLE'))).toBeGreaterThan(0)
    expect(counts()).toEqual({ reserved: 1, released: 1 })
  })

  it('waits for a holder to finish, then runs', async () => {
    const directory = await migrationDir({ '0001_a.sql': 'A;' })
    const { client, events } = fakeClient({ lockAnswers: [false, false, true] })
    const sleeps: number[] = []
    await runMigrations(client, directory, quiet, { pollMs: 10, sleep: async (ms) => { sleeps.push(ms) } })
    expect(sleeps).toEqual([10, 10])
    expect(events.filter((event) => event.startsWith('run '))).toEqual(['run A;'])
  })

  it('gives up after the timeout without running anything, and still releases the connection', async () => {
    const directory = await migrationDir({ '0001_a.sql': 'A;' })
    const { client, events, counts } = fakeClient({ lockAnswers: [false] })
    await expect(runMigrations(client, directory, quiet, { lockTimeoutMs: 30, pollMs: 10, sleep: async () => undefined })).rejects.toThrow('Timed out')
    expect(events.some((event) => event.startsWith('run '))).toBe(false)
    expect(events.some((event) => event.includes('pg_advisory_unlock'))).toBe(false)
    expect(counts()).toEqual({ reserved: 1, released: 1 })
  })

  it('unlocks and releases when a migration fails', async () => {
    const directory = await migrationDir({ '0001_a.sql': 'SELECT 1;' })
    const { client, events, counts } = fakeClient({ failRun: true })
    await expect(runMigrations(client, directory, quiet)).rejects.toThrow('boom')
    expect(events).toContain('ROLLBACK')
    expect(events).not.toContain('COMMIT')
    expect(events.at(-1)).toBe('SELECT pg_advisory_unlock(?)')
    expect(counts()).toEqual({ reserved: 1, released: 1 })
  })

  it('applies only unapplied files, in filename order', async () => {
    const directory = await migrationDir({ '0002_b.sql': 'B;', '0001_a.sql': 'A;', '0003_c.sql': 'C;' })
    const { client, events } = fakeClient({ applied: ['0001_a.sql'] })
    const logged: string[] = []
    await runMigrations(client, directory, (message) => logged.push(message))
    expect(events.filter((event) => event.startsWith('run '))).toEqual(['run B;', 'run C;'])
    expect(events.filter((event) => event === 'BEGIN' || event === 'COMMIT')).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
    expect(logged).toEqual(['Applied migration 0002_b.sql', 'Applied migration 0003_c.sql'])
  })
})
