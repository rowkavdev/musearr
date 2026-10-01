import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type postgres from 'postgres'

// Arbitrary constant shared by every Musearr migrator, so only one runs at a time.
const MIGRATION_LOCK_ID = 7_340_113_201

export type MigrationOptions = {
  /** How long to wait for another migrator to finish before giving up. */
  lockTimeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Applies pending .sql migrations in filename order. One migrator runs at a
 * time: it reserves a single connection, so the session-level advisory lock
 * cannot move to another connection mid-run, and it waits a bounded time for
 * a holder to finish instead of hanging forever. The lock is released with the
 * session even if this process dies.
 */
export async function runMigrations(
  client: postgres.Sql,
  migrationDirectory: string,
  log: (message: string) => void = console.info,
  { lockTimeoutMs = 120_000, pollMs = 500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: MigrationOptions = {},
): Promise<void> {
  const database = await client.reserve()
  try {
    let waited = 0
    for (;;) {
      const [row] = await database<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_ID}) AS locked`
      if (row?.locked) break
      if (waited >= lockTimeoutMs) {
        throw new Error('Timed out waiting for another migration run to finish.')
      }
      await sleep(pollMs)
      waited += pollMs
    }

    try {
      await database`
        CREATE TABLE IF NOT EXISTS musearr_schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT NOW()
        )
      `

      const applied = await database<Array<{ name: string }>>`
        SELECT name FROM musearr_schema_migrations
      `
      const appliedNames = new Set(applied.map((migration) => migration.name))
      const migrationFiles = (await readdir(migrationDirectory))
        .filter((file) => file.endsWith('.sql'))
        .sort()

      for (const name of migrationFiles) {
        if (appliedNames.has(name)) {
          continue
        }

        const source = await readFile(join(migrationDirectory, name), 'utf8')
        // A reserved connection has no begin(), so run the transaction by hand
        // on the same pinned connection that holds the lock.
        await database.unsafe('BEGIN')
        try {
          await database.unsafe(source)
          await database`INSERT INTO musearr_schema_migrations (name) VALUES (${name})`
          await database.unsafe('COMMIT')
        } catch (error) {
          await database.unsafe('ROLLBACK')
          throw error
        }
        log(`Applied migration ${name}`)
      }
    } finally {
      await database`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`
    }
  } finally {
    database.release()
  }
}
