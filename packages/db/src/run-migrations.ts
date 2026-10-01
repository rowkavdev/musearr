import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type postgres from 'postgres'

/** Applies pending .sql migrations in filename order. */
export async function runMigrations(
  database: postgres.Sql,
  migrationDirectory: string,
  log: (message: string) => void = console.info,
): Promise<void> {
  {
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
  }
}
