import { describe, expect, it } from 'vitest'
import { PlexConnectionError } from '@musearr/plex'
import { sanitiseSyncFailure } from './library-sync.js'

describe('library sync failure sanitisation', () => {
  it.each([
    [new Error('MUSEARR_ENCRYPTION_KEY is required before Plex sync can run.'), 'configuration', false],
    [new Error('Plex token was unauthorized'), 'authentication', false],
    [new Error('network timeout connecting to Plex'), 'upstream_unavailable', true],
    [new Error('Plex response parse failed'), 'upstream_response', true],
    [new PlexConnectionError('UNREACHABLE', 'Musearr could not reach the Plex server.'), 'upstream_unavailable', true],
    [new PlexConnectionError('UNAUTHENTICATED', 'Plex rejected the supplied token.'), 'authentication', false],
    [new PlexConnectionError('INVALID_RESPONSE', 'Plex returned an unreadable response.'), 'upstream_response', true],
    ['token=secret-value', 'unknown', true],
    // A body that is not JSON is an odd answer from the server, not a rejected login.
    [new SyntaxError('Unexpected token < in JSON at position 0'), 'upstream_response', true],
    // A failed database write mentioning a token is not a Plex authentication failure.
    [new Error('invalid input syntax for type uuid: bad token'), 'unknown', true],
  ] as const)('persists only stable safe details for %s', (error, classification, retryable) => {
    const failure = sanitiseSyncFailure(error)

    expect(failure).toMatchObject({ classification, retryable })
    expect(failure.summary).not.toContain('secret-value')
    expect(failure.summary).not.toContain('token=')
  })
})
