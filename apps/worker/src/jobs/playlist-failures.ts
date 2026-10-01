export type PlaylistFailureClassification =
  | 'configuration'
  | 'authentication'
  | 'acquisition_unavailable'
  | 'plex_write_failed'
  | 'unknown'

export type SanitisedPlaylistFailure = {
  classification: PlaylistFailureClassification
  summary: string
  retryable: boolean
}

/** Converts an operational error into a stable, secret-safe persisted summary. */
export function sanitisePlaylistFailure(error: unknown): SanitisedPlaylistFailure {
  const message = error instanceof Error ? error.message.toLowerCase() : ''

  if (
    message.includes('encryption') ||
    message.includes('configuration') ||
    message.includes('required before') ||
    message.includes('no plex') ||
    message.includes('not configured') ||
    message.includes('no longer in the library') ||
    message.includes('missing a root folder')
  ) {
    return { classification: 'configuration', summary: 'Playlist configuration needs attention.', retryable: false }
  }
  if (
    message.includes('unauthor') ||
    message.includes('forbidden') ||
    message.includes('api key') ||
    message.includes('token') ||
    message.includes('credential')
  ) {
    return { classification: 'authentication', summary: 'A connected service rejected its credentials.', retryable: false }
  }
  if (message.includes('lidarr') || message.includes('acquisition')) {
    return {
      classification: 'acquisition_unavailable',
      summary: 'The acquisition backend was unavailable.',
      retryable: true,
    }
  }
  if (message.includes('plex')) {
    return { classification: 'plex_write_failed', summary: 'Musearr could not update the Plex playlist.', retryable: true }
  }
  return { classification: 'unknown', summary: 'The playlist run did not complete.', retryable: true }
}
