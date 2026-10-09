/** The connection details a Test connection request was sent with. */
export type ConnectionTestDetails = {
  baseUrl: string
  token: string
}

export type VerifiedConnection = {
  machineIdentifier: string
  serverName: string
  version: string | null
  musicLibraries: Array<{ id: string; title: string; type: 'artist' }>
}

/**
 * Runs one Test connection request and applies the outcome only while it is
 * still current.
 *
 * The address and token inputs stay editable while the request is out, and a
 * Plex sign-in or server choice can replace them too. Each of those paths
 * bumps a synchronous request generation; the caller passes `isCurrent` so a
 * response that returns after any of those edits is dropped instead of
 * restoring the verified-server panel and library choices for a server the
 * form no longer describes.
 */
export async function runConnectionTest(options: {
  fetchImpl: typeof fetch
  details: ConnectionTestDetails
  isCurrent: () => boolean
  readIssue: (response: Response) => Promise<string>
  onVerified: (connection: VerifiedConnection) => void
  onFailure: (message: string) => void
}): Promise<void> {
  try {
    const response = await options.fetchImpl('/api/v1/setup/test-plex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.details),
    })
    if (!response.ok) {
      throw new Error(await options.readIssue(response))
    }
    const result = (await response.json()) as VerifiedConnection
    if (!options.isCurrent()) {
      return
    }
    options.onVerified(result)
  } catch (error) {
    if (!options.isCurrent()) {
      return
    }
    options.onFailure(error instanceof Error ? error.message : 'Musearr could not reach Plex.')
  }
}
