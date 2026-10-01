import { describe, expect, it } from 'vitest'
import { insertInitialSetup, type Database } from './repository.js'

// A small in-memory stand-in for Postgres that honours transaction-level advisory locks and
// yields between statements, so two overlapping setups can interleave the way real ones do.
function fakeDatabase() {
  const state = { instances: 0, users: [] as string[] }
  let lockHeld: Promise<void> | null = null
  const yieldTurn = () => new Promise((resolve) => setImmediate(resolve))

  const database = {
    begin: async (work: (tx: unknown) => Promise<unknown>) => {
      let release: () => void = () => {}
      let ownsLock = false
      const transaction = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join('?')
        await yieldTurn()
        if (query.includes('pg_advisory_xact_lock')) {
          while (lockHeld) await lockHeld
          lockHeld = new Promise<void>((resolve) => (release = resolve))
          ownsLock = true
          return []
        }
        if (query.includes('FROM instances')) return state.instances > 0 ? [{ id: 'instance' }] : []
        if (query.includes('INSERT INTO instances')) {
          state.instances += 1
          return []
        }
        if (query.includes('INSERT INTO users')) {
          state.users.push(String(values[0]))
          return [{ id: `user-${state.users.length}`, username: String(values[0]), role: 'owner' }]
        }
        if (query.includes('INSERT INTO plex_servers')) {
          return [{ id: 'server', name: 'Plex', machine_identifier: String(values[0]) }]
        }
        return []
      }
      try {
        return await work(transaction)
      } finally {
        if (ownsLock) {
          lockHeld = null
          release()
        }
      }
    },
  }
  return { database: database as unknown as Database, state }
}

const setup = (ownerUsername: string, machineIdentifier: string) => ({
  ownerUsername,
  passwordHash: 'hash',
  machineIdentifier,
  serverName: 'Plex',
  baseUrl: 'http://plex.local:32400',
  tokenCiphertext: 'cipher',
  selectedLibraries: [{ plexSectionId: '1', title: 'Music' }],
})

describe('insertInitialSetup', () => {
  it('lets only one of two overlapping setup requests create an owner', async () => {
    const { database, state } = fakeDatabase()
    const results = await Promise.allSettled([
      insertInitialSetup(database, setup('owner', 'server-a')),
      insertInitialSetup(database, setup('intruder', 'server-b')),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ message: 'INSTANCE_ALREADY_CONFIGURED' })
    expect(state.instances).toBe(1)
    expect(state.users).toHaveLength(1)
  })
})
