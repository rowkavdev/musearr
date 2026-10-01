import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { runMigrations } from './run-migrations.js'

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations.')
  }

  const database = postgres(databaseUrl, { max: 1, connect_timeout: 8 })
  try {
    await runMigrations(database, migrationDirectory)
  } finally {
    await database.end({ timeout: 5 })
  }
}

migrate().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
