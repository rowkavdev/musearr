import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type postgres from 'postgres'

// Arbitrary constant shared by every Musearr migrator, so only one runs at a time.
const MIGRATION_LOCK_ID = 7_340_113_201

/**
 * Applies pending .sql migrations in filename order. The database must be a
 * single-connection client: the advisory lock belongs to that session and is
 * released when it ends, so a crashed migrator cannot leave it held.
 */
export async function runMigrations(
  database: postgres.Sql,
  migrationDirectory: string,
  log: (message: string) => void = console.info,
): Promise<void> {
  await database`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`
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
      await database.begin(async (transaction) => {
        await transaction.unsafe(source)
        await transaction`INSERT INTO musearr_schema_migrations (name) VALUES (${name})`
      })
      log(`Applied migration ${name}`)
    }
  } finally {
    await database`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`
  }
}
