import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './run-migrations.js'

// A recording stand-in for the single-connection postgres client. It is a
// tagged template that logs each statement, plus begin() for transactions.
function fakeDatabase(applied: string[] = []) {
  const events: string[] = []
  const database = (async (strings: TemplateStringsArray) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim()
    events.push(sql)
    return sql.startsWith('SELECT name FROM') ? applied.map((name) => ({ name })) : []
  }) as unknown as Parameters<typeof runMigrations>[0]
  ;(database as unknown as { begin: unknown }).begin = async (work: (tx: unknown) => Promise<void>) => {
    const transaction = Object.assign(async (strings: TemplateStringsArray) => { events.push(`tx ${strings.join('?').trim()}`) }, {
      unsafe: async (source: string) => { events.push(`run ${source}`) },
    })
    await work(transaction)
  }
  return { database, events }
}

async function migrationDir(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'musearr-migrations-'))
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source)
  return directory
}

describe('runMigrations', () => {
  it('applies only unapplied files, in filename order', async () => {
    const directory = await migrationDir({ '0002_b.sql': 'B;', '0001_a.sql': 'A;', '0003_c.sql': 'C;' })
    const { database, events } = fakeDatabase(['0001_a.sql'])
    const logged: string[] = []
    await runMigrations(database, directory, (message) => logged.push(message))
    expect(events.filter((event) => event.startsWith('run '))).toEqual(['run B;', 'run C;'])
    expect(logged).toEqual(['Applied migration 0002_b.sql', 'Applied migration 0003_c.sql'])
  })
})
