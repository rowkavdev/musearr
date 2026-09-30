import type { LidarrConnectionResult } from '@musearr/contracts'

const LIDARR_HEADERS = {
  Accept: 'application/json',
  'X-Musearr-Product': 'Musearr',
} as const

const REQUEST_TIMEOUT_MS = 10_000

export class LidarrConnectionError extends Error {
  public readonly code: 'UNREACHABLE' | 'UNAUTHENTICATED' | 'INVALID_RESPONSE'

  constructor(code: LidarrConnectionError['code'], message: string) {
    super(message)
    this.name = 'LidarrConnectionError'
    this.code = code
  }
}

/**
 * Accepts only a bare `http(s)` origin, matching the Plex adapter's hardening.
 * The base URL is operator-supplied and later used for outbound requests, so it
 * must not carry credentials, a query string, or a fragment.
 */
export function normaliseLidarrBaseUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new LidarrConnectionError('INVALID_RESPONSE', 'Enter a valid Lidarr server address.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new LidarrConnectionError('INVALID_RESPONSE', 'Use an HTTP or HTTPS Lidarr server address.')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LidarrConnectionError(
      'INVALID_RESPONSE',
      'Use only the Lidarr origin, without credentials or query parameters.',
    )
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

export type LidarrRootFolder = {
  id: number
  path: string
  freeSpaceBytes: number | null
}

export type LidarrProfile = {
  id: number
  name: string
}

export type LidarrArtistLookup = {
  foreignArtistId: string
  artistName: string
  disambiguation: string | null
  overview: string | null
}

export type LidarrArtist = {
  id: number
  foreignArtistId: string
  artistName: string
  monitored: boolean
}

export type LidarrAlbum = {
  id: number
  foreignAlbumId: string
  title: string
  monitored: boolean
  artistId: number
}

export type LidarrQueueRecord = {
  id: number
  artistId: number | null
  albumId: number | null
  status: string
  trackedDownloadState: string | null
  title: string | null
}

export type LidarrTrackFile = {
  id: number
  artistId: number
  albumId: number
  path: string | null
  dateAdded: string | null
}

export type LidarrAddArtistInput = {
  foreignArtistId: string
  artistName: string
  qualityProfileId: number
  metadataProfileId: number
  rootFolderPath: string
  monitored?: boolean
}

type UnknownRecord = Record<string, unknown>

export class LidarrClient {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = normaliseLidarrBaseUrl(baseUrl)
    this.apiKey = apiKey
  }

  async testConnection(): Promise<LidarrConnectionResult> {
    const [status, rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([
      this.systemStatus(),
      this.rootFolders(),
      this.qualityProfiles(),
      this.metadataProfiles(),
    ])

    return {
      version: status.version,
      instanceName: status.instanceName,
      authenticated: true,
      rootFolders: rootFolders.map((folder) => ({
        id: folder.id,
        path: folder.path,
        freeSpaceBytes: folder.freeSpaceBytes,
      })),
      qualityProfiles: qualityProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
      metadataProfiles: metadataProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
    }
  }

  async systemStatus(): Promise<{ version: string; instanceName: string | null }> {
    const payload = await this.request<UnknownRecord>('GET', '/api/v1/system/status')
    return {
      version: stringOr(payload.version, '0.0.0'),
      instanceName: optionalString(payload.instanceName),
    }
  }

  async rootFolders(): Promise<LidarrRootFolder[]> {
    const payload = await this.request<UnknownRecord[]>('GET', '/api/v1/rootfolder')
    return asArray(payload).flatMap((raw) => {
      const id = integerOrNull(raw.id)
      const path = optionalString(raw.path)
      if (id === null || !path) {
        return []
      }
      return [{ id, path, freeSpaceBytes: integerOrNull(raw.freeSpace) }]
    })
  }

  async qualityProfiles(): Promise<LidarrProfile[]> {
    return this.profiles('/api/v1/qualityprofile')
  }

  async metadataProfiles(): Promise<LidarrProfile[]> {
    return this.profiles('/api/v1/metadataprofile')
  }

  async lookupArtist(term: string): Promise<LidarrArtistLookup[]> {
    const payload = await this.request<UnknownRecord[]>(
      'GET',
      `/api/v1/artist/lookup?term=${encodeURIComponent(term)}`,
    )
    return asArray(payload).flatMap((raw) => {
      const foreignArtistId = optionalString(raw.foreignArtistId)
      const artistName = optionalString(raw.artistName)
      if (!foreignArtistId || !artistName) {
        return []
      }
      return [
        {
          foreignArtistId,
          artistName,
          disambiguation: optionalString(raw.disambiguation),
          overview: optionalString(raw.overview),
        },
      ]
    })
  }

  async getArtists(): Promise<LidarrArtist[]> {
    const payload = await this.request<UnknownRecord[]>('GET', '/api/v1/artist')
    return asArray(payload).flatMap((raw) => normaliseArtist(raw))
  }

  async addArtist(input: LidarrAddArtistInput): Promise<LidarrArtist> {
    const body = {
      foreignArtistId: input.foreignArtistId,
      artistName: input.artistName,
      qualityProfileId: input.qualityProfileId,
      metadataProfileId: input.metadataProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored: input.monitored ?? true,
      addOptions: { monitor: 'all', searchForMissingAlbums: false },
    }
    const payload = await this.request<UnknownRecord>('POST', '/api/v1/artist', body)
    const [artist] = normaliseArtist(payload)
    if (!artist) {
      throw new LidarrConnectionError('INVALID_RESPONSE', 'Lidarr did not confirm the added artist.')
    }
    return artist
  }

  async getAlbums(artistId: number): Promise<LidarrAlbum[]> {
    const payload = await this.request<UnknownRecord[]>(
      'GET',
      `/api/v1/album?artistId=${encodeURIComponent(String(artistId))}`,
    )
    return asArray(payload).flatMap((raw) => {
      const id = integerOrNull(raw.id)
      const title = optionalString(raw.title)
      const albumArtistId = integerOrNull(raw.artistId)
      if (id === null || !title) {
        return []
      }
      return [
        {
          id,
          foreignAlbumId: stringOr(raw.foreignAlbumId, ''),
          title,
          monitored: raw.monitored === true,
          artistId: albumArtistId ?? artistId,
        },
      ]
    })
  }

  async setAlbumsMonitored(albumIds: number[], monitored: boolean): Promise<void> {
    if (albumIds.length === 0) {
      return
    }
    await this.request('PUT', '/api/v1/album/monitor', { albumIds, monitored })
  }

  /** Triggers a Lidarr `AlbumSearch` command for the given album ids. */
  async searchAlbums(albumIds: number[]): Promise<void> {
    if (albumIds.length === 0) {
      return
    }
    await this.request('POST', '/api/v1/command', { name: 'AlbumSearch', albumIds })
  }

  async getQueue(): Promise<LidarrQueueRecord[]> {
    const payload = await this.request<UnknownRecord>(
      'GET',
      '/api/v1/queue?pageSize=200&includeArtist=false&includeAlbum=false',
    )
    const records = Array.isArray(payload.records) ? (payload.records as UnknownRecord[]) : asArray(payload)
    return records.flatMap((raw) => {
      const id = integerOrNull(raw.id)
      if (id === null) {
        return []
      }
      return [
        {
          id,
          artistId: integerOrNull(raw.artistId),
          albumId: integerOrNull(raw.albumId),
          status: stringOr(raw.status, 'unknown'),
          trackedDownloadState: optionalString(raw.trackedDownloadState),
          title: optionalString(raw.title),
        },
      ]
    })
  }

  async getTrackFiles(artistId: number): Promise<LidarrTrackFile[]> {
    const payload = await this.request<UnknownRecord[]>(
      'GET',
      `/api/v1/trackfile?artistId=${encodeURIComponent(String(artistId))}`,
    )
    return asArray(payload).flatMap((raw) => {
      const id = integerOrNull(raw.id)
      const fileArtistId = integerOrNull(raw.artistId)
      const albumId = integerOrNull(raw.albumId)
      if (id === null || fileArtistId === null || albumId === null) {
        return []
      }
      return [
        {
          id,
          artistId: fileArtistId,
          albumId,
          path: optionalString(raw.path),
          dateAdded: optionalString(raw.dateAdded),
        },
      ]
    })
  }

  private async profiles(path: string): Promise<LidarrProfile[]> {
    const payload = await this.request<UnknownRecord[]>('GET', path)
    return asArray(payload).flatMap((raw) => {
      const id = integerOrNull(raw.id)
      const name = optionalString(raw.name)
      if (id === null || !name) {
        return []
      }
      return [{ id, name }]
    })
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...LIDARR_HEADERS,
          'X-Api-Key': this.apiKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })

      if (response.status === 401 || response.status === 403) {
        throw new LidarrConnectionError('UNAUTHENTICATED', 'Lidarr rejected the supplied API key.')
      }
      if (!response.ok) {
        throw new LidarrConnectionError('UNREACHABLE', 'Musearr could not reach the Lidarr server.')
      }

      if (response.status === 204) {
        return undefined as T
      }

      const text = await readBoundedResponse(response)
      if (text.trim().length === 0) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new LidarrConnectionError('INVALID_RESPONSE', 'Lidarr returned an unreadable response.')
      }
    } catch (error) {
      if (error instanceof LidarrConnectionError) {
        throw error
      }
      throw new LidarrConnectionError('UNREACHABLE', 'Musearr could not reach the Lidarr server.')
    } finally {
      clearTimeout(timeout)
    }
  }
}

function normaliseArtist(raw: UnknownRecord): LidarrArtist[] {
  const id = integerOrNull(raw.id)
  const artistName = optionalString(raw.artistName)
  if (id === null || !artistName) {
    return []
  }
  return [
    {
      id,
      foreignArtistId: stringOr(raw.foreignArtistId, ''),
      artistName,
      monitored: raw.monitored === true,
    },
  ]
}

function asArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? (value as UnknownRecord[]) : []
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

// Caps decoded bytes too: Content-Length can be missing, wrong, or compressed.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new LidarrConnectionError('INVALID_RESPONSE', 'Lidarr response exceeds the 16 MiB limit.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new LidarrConnectionError('INVALID_RESPONSE', 'Lidarr response exceeds the 16 MiB limit.')
      }
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } finally {
    reader.releaseLock()
  }
}
