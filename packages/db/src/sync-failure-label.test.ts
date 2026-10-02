import { describe, expect, it } from 'vitest'
import { failSyncRun } from './repository.js'
import type { Database } from './repository.js'

// failSyncRun writes one tagged-template UPDATE; the second interpolated value is the stored summary.
async function storedSummary(error: unknown): Promise<string> {
  let summary = ''
  const database = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    summary = String(values[0])
    return []
  }) as unknown as Database
  await failSyncRun(database, 'run-1', error)
  return summary
}

describe('failSyncRun labels', () => {
  it('records an unexpected non-JSON body as an unexpected response, not a rejected login', async () => {
    expect(await storedSummary(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe(
      'upstream_response: Plex returned an unexpected response.',
    )
  })

  it('does not call a non-Plex error that mentions a token an authentication failure', async () => {
    expect(await storedSummary(new Error('invalid input syntax for type uuid: bad token'))).toBe(
      'unknown: The sync did not complete.',
    )
  })

  it('still labels a Plex token problem as authentication', async () => {
    expect(await storedSummary(new Error('Plex token was unauthorized'))).toBe(
      'authentication: Plex authentication was rejected.',
    )
  })
})
