import { describe, expect, it } from 'vitest'
import { queueLibrarySync } from './queue-sync'

describe('queueLibrarySync', () => {
  it('reports queued on 202', async () => {
    expect(await queueLibrarySync(async () => ({ ok: true, status: 202 }))).toBe('queued')
  })
  it('reports signed_out on 401', async () => {
    expect(await queueLibrarySync(async () => ({ ok: false, status: 401 }))).toBe('signed_out')
  })
  it.each([403, 404, 500, 503])('reports failed on %i', async (status) => {
    expect(await queueLibrarySync(async () => ({ ok: false, status }))).toBe('failed')
  })
  it('reports failed when the request throws', async () => {
    expect(await queueLibrarySync(async () => { throw new Error('net') })).toBe('failed')
  })
})
