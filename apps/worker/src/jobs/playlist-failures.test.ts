import { describe, expect, it } from 'vitest'
import { sanitisePlaylistFailure } from './playlist-failures.js'

describe('playlist failure sanitisation', () => {
  it.each([
    [new Error('MUSEARR_ENCRYPTION_KEY is required before publish can run.'), 'configuration', false],
    [new Error('The seed track is no longer in the library.'), 'configuration', false],
    [new Error('Lidarr rejected the supplied API key'), 'authentication', false],
    [new Error('Lidarr is missing a root folder or quality/metadata profile for new artists.'), 'configuration', false],
    [new Error('Musearr could not reach the Lidarr server.'), 'acquisition_unavailable', true],
    [new Error('Plex returned an unreadable response'), 'plex_write_failed', true],
    ['api-key=secret-value', 'unknown', true],
  ] as const)('keeps only stable safe details for %s', (error, classification, retryable) => {
    const failure = sanitisePlaylistFailure(error)
    expect(failure).toMatchObject({ classification, retryable })
    expect(failure.summary).not.toContain('secret-value')
    expect(failure.summary).not.toContain('api-key=')
  })
})
