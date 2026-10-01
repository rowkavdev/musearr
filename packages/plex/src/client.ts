import type { PlexConnectionResult, PlexLibrarySection } from '@musearr/contracts'

const PLEX_HEADERS = {
  Accept: 'application/json',
  'X-Plex-Product': 'Musearr',
  'X-Plex-Version': '0.1.0',
  'X-Plex-Client-Identifier': 'musearr-server',
} as const

type PlexIdentityResponse = {
  MediaContainer?: {
    machineIdentifier?: string
    friendlyName?: string
    version?: string
  }
}

type PlexSectionsResponse = {
  MediaContainer?: {
    Directory?: Array<{
      key?: string | number
      title?: string
      type?: string
    }>
  }
}

type PlexTrackResponse = {
  MediaContainer?: {
    size?: number
    totalSize?: number
    Metadata?: Array<{
      ratingKey?: string | number
      title?: string
      index?: number
      parentIndex?: number
      duration?: number
      addedAt?: number
      updatedAt?: number
      viewCount?: number
      lastViewedAt?: number
      userRating?: number
      parentRatingKey?: string | number
      parentTitle?: string
      parentYear?: number
      parentThumb?: string
      grandparentRatingKey?: string | number
      grandparentTitle?: string
      grandparentThumb?: string
      Genre?: Array<{ tag?: string }>
    }>
  }
}

type PlexPlaylistResponse = {
  MediaContainer?: {
    Metadata?: Array<{
      ratingKey?: string | number
      title?: string
      playlistType?: string
      updatedAt?: number
    }>
  }
}

type PlexPlaylistItemsResponse = {
  MediaContainer?: {
    size?: number
    totalSize?: number
    Metadata?: Array<{
      ratingKey?: string | number
      addedAt?: number
    }>
  }
}

export type PlexLibraryTrack = {
  plexRatingKey: string
  title: string
  trackNumber: number | null
  discNumber: number | null
  durationMs: number | null
  addedAt: string | null
  plexUpdatedAt: string | null
  playCount: number
  lastPlayedAt: string | null
  rating: number | null
  artist: {
    plexRatingKey: string
    name: string
    thumbKey: string | null
  }
  album: {
    plexRatingKey: string
    title: string
    year: number | null
    thumbKey: string | null
  }
  genres: string[]
}

export type PlexTrackPage = {
  total: number
  offset: number
  scanned: number
  items: PlexLibraryTrack[]
  skipped: number
}

export type PlexPlaylist = {
  plexRatingKey: string
  title: string
  revision: string | null
}

export type PlexPlaylistItem = {
  plexTrackRatingKey: string
  addedAt: string | null
}

export type PlexPlaylistItemPage = {
  total: number
  offset: number
  scanned: number
  items: PlexPlaylistItem[]
  skipped: number
}

const PLEX_TV_BASE_URL = 'https://plex.tv'

export type PlexPin = {
  id: number
  code: string
  authToken: string | null
}

export type PlexAuthorizedServer = {
  name: string
  machineIdentifier: string
  baseUrl: string
}

export class PlexConnectionError extends Error {
  public readonly code: 'UNREACHABLE' | 'UNAUTHENTICATED' | 'INVALID_RESPONSE'

  constructor(code: PlexConnectionError['code'], message: string) {
    super(message)
    this.name = 'PlexConnectionError'
    this.code = code
  }
}

export function normalisePlexBaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new PlexConnectionError('INVALID_RESPONSE', 'Use an HTTP or HTTPS Plex server address.')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PlexConnectionError('INVALID_RESPONSE', 'Use only the Plex server origin, without credentials or query parameters.')
  }

  if (isLinkLocalHost(parsed.hostname)) {
    throw new PlexConnectionError('INVALID_RESPONSE', 'Use the address of your Plex server, not a link-local or cloud metadata address.')
  }

  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  return parsed.toString().replace(/\/$/, '')
}

// Link-local ranges and cloud metadata names are never a Plex server, and they
// are the usual SSRF targets (#83). LAN, Docker host and loopback stay allowed.
function isLinkLocalHost(rawHost: string): boolean {
  let host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  // WHATWG URL rewrites ::ffff:a.b.c.d to two hex groups, e.g. ::ffff:a9fe:a9fe.
  // Decode it back so the IPv4 checks below apply to mapped addresses too.
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    const high = parseInt(mapped[1] as string, 16)
    const low = parseInt(mapped[2] as string, 16)
    host = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  if (host === 'metadata.google.internal' || host === 'metadata.goog') return true
  // Alibaba Cloud and AWS IPv6 metadata endpoints.
  if (host === '100.100.100.200' || host === 'fd00:ec2::254') return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return /^fe[89ab][0-9a-f]:/.test(host)
}

export class PlexClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = normalisePlexBaseUrl(baseUrl)
    this.token = token
  }

  async testConnection(): Promise<PlexConnectionResult> {
    const [identity, sections] = await Promise.all([this.identity(), this.librarySections()])
    const machineIdentifier = identity.MediaContainer?.machineIdentifier

    if (!machineIdentifier) {
      throw new PlexConnectionError('INVALID_RESPONSE', 'Plex did not return a server identity.')
    }

    return {
      machineIdentifier,
      serverName: identity.MediaContainer?.friendlyName ?? 'Plex Media Server',
      version: identity.MediaContainer?.version ?? null,
      musicLibraries: sections,
    }
  }

  async libraryTracks(sectionId: string, offset: number, size: number): Promise<PlexTrackPage> {
    const start = Math.max(0, Math.floor(offset))
    const pageSize = Math.min(500, Math.max(1, Math.floor(size)))
    const payload = await this.request<PlexTrackResponse>(
      `/library/sections/${encodeURIComponent(sectionId)}/all?type=10&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`,
    )
    const metadata = plexRows(payload.MediaContainer?.Metadata)
    const received = payload.MediaContainer?.Metadata?.length ?? 0
    const tracks = metadata.flatMap((item) => normaliseTrack(item))

    return {
      total: payload.MediaContainer?.totalSize ?? tracks.length,
      offset: start,
      scanned: received,
      items: tracks,
      skipped: received - tracks.length,
    }
  }

  async audioPlaylists(): Promise<PlexPlaylist[]> {
    const payload = await this.request<PlexPlaylistResponse>('/playlists?playlistType=audio')
    return plexRows(payload.MediaContainer?.Metadata)
      .filter((playlist) => playlist.ratingKey !== undefined && playlist.title && playlist.playlistType === 'audio')
      .map((playlist) => ({
        plexRatingKey: String(playlist.ratingKey),
        title: playlist.title as string,
        revision: timestampOrNull(playlist.updatedAt),
      }))
  }

  async playlistItems(playlistId: string, offset: number, size: number): Promise<PlexPlaylistItemPage> {
    const start = Math.max(0, Math.floor(offset))
    const pageSize = Math.min(500, Math.max(1, Math.floor(size)))
    const payload = await this.request<PlexPlaylistItemsResponse>(
      `/playlists/${encodeURIComponent(playlistId)}/items?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`,
    )
    const metadata = plexRows(payload.MediaContainer?.Metadata)
    const received = payload.MediaContainer?.Metadata?.length ?? 0
    const items = metadata.flatMap((item) => {
      if (item.ratingKey === undefined) {
        return []
      }
      return [
        {
          plexTrackRatingKey: String(item.ratingKey),
          addedAt: timestampOrNull(item.addedAt),
        },
      ]
    })

    return {
      total: payload.MediaContainer?.totalSize ?? items.length,
      offset: start,
      scanned: received,
      items,
      skipped: received - items.length,
    }
  }

  /**
   * Creates a Musearr-managed audio playlist from a list of track rating keys.
   *
   * NOTE: Plex expects the seed items as a `uri` pointing at library metadata on
   * the owning server. The exact `server://{machineIdentifier}/...` form below is
   * the one place to adjust if a live server rejects it. Callers must only pass
   * this the rating keys of a playlist Musearr itself owns.
   */
  async createAudioPlaylist(
    machineIdentifier: string,
    title: string,
    trackRatingKeys: string[],
  ): Promise<{ plexRatingKey: string }> {
    if (trackRatingKeys.length === 0) {
      throw new PlexConnectionError('INVALID_RESPONSE', 'A new Plex playlist needs at least one track.')
    }
    const uri = serverLibraryUri(machineIdentifier, trackRatingKeys)
    const payload = await this.request<PlexPlaylistResponse>(
      `/playlists?type=audio&smart=0&title=${encodeURIComponent(title)}&uri=${encodeURIComponent(uri)}`,
      { method: 'POST' },
    )
    const ratingKey = payload?.MediaContainer?.Metadata?.[0]?.ratingKey
    if (ratingKey === undefined) {
      throw new PlexConnectionError('INVALID_RESPONSE', 'Plex did not return the created playlist.')
    }
    return { plexRatingKey: String(ratingKey) }
  }

  /** Appends tracks to an existing playlist. Safe to call with keys already present. */
  async addPlaylistItems(
    playlistId: string,
    machineIdentifier: string,
    trackRatingKeys: string[],
  ): Promise<void> {
    if (trackRatingKeys.length === 0) {
      return
    }
    const uri = serverLibraryUri(machineIdentifier, trackRatingKeys)
    await this.request<PlexPlaylistItemsResponse>(
      `/playlists/${encodeURIComponent(playlistId)}/items?uri=${encodeURIComponent(uri)}`,
      { method: 'PUT' },
    )
  }

  async findAudioPlaylistByTitle(title: string): Promise<PlexPlaylist | null> {
    const playlists = await this.audioPlaylists()
    return playlists.find((playlist) => playlist.title === title) ?? null
  }

  private async identity(): Promise<PlexIdentityResponse> {
    return this.request<PlexIdentityResponse>('/identity')
  }

  private async librarySections(): Promise<PlexLibrarySection[]> {
    const payload = await this.request<PlexSectionsResponse>('/library/sections')
    return (payload.MediaContainer?.Directory ?? [])
      .filter((section) => section.type === 'artist' && section.key !== undefined && section.title)
      .map((section) => ({
        id: String(section.key),
        title: section.title as string,
        type: 'artist',
      }))
  }

  async createPlaylist(title: string, trackRatingKeys: string[]): Promise<{ plexRatingKey: string; title: string }> {
    if (trackRatingKeys.length === 0) {
      throw new PlexConnectionError('INVALID_RESPONSE', 'Cannot create an empty playlist.')
    }
    const identity = await this.identity()
    const machineIdentifier = identity.MediaContainer?.machineIdentifier
    if (!machineIdentifier) {
      throw new PlexConnectionError('INVALID_RESPONSE', 'Plex did not return a server identity.')
    }

    const uriList = trackRatingKeys
      .map((key) => `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${key}`)
      .join(',')

    const path = `/playlists?type=audio&title=${encodeURIComponent(title)}&smart=0&uri=${encodeURIComponent(uriList)}`
    const payload = await this.request<PlexPlaylistResponse>(path, { method: 'POST' })
    const created = payload?.MediaContainer?.Metadata?.[0]
    if (!created?.ratingKey) {
      throw new PlexConnectionError('INVALID_RESPONSE', 'Plex failed to create playlist.')
    }

    return {
      plexRatingKey: String(created.ratingKey),
      title: created.title ?? title,
    }
  }


  private async request<T>(path: string, init: { method?: string } = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    const method = init.method ?? 'GET'

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        redirect: 'error',
        method,
        headers: {
          ...PLEX_HEADERS,
          'X-Plex-Token': this.token,
        },
        signal: controller.signal,
      })

      if (response.status === 401 || response.status === 403) {
        throw new PlexConnectionError('UNAUTHENTICATED', 'Plex rejected the supplied token.')
      }
      if (!response.ok) {
        throw new PlexConnectionError('UNREACHABLE', 'Musearr could not reach the Plex server.')
      }

      const text = response.status === 204 ? '' : await readBoundedResponse(response)
      if (text.trim().length === 0) {
        if (method !== 'GET') {
          return undefined as T
        }
        throw new PlexConnectionError('INVALID_RESPONSE', 'Plex returned an empty response.')
      }
      try {
        const parsed: unknown = JSON.parse(text)
        if (method === 'GET' && (parsed === null || typeof parsed !== 'object')) {
          throw new Error('not an object')
        }
        return parsed as T
      } catch {
        throw new PlexConnectionError('INVALID_RESPONSE', 'Plex returned an unreadable response.')
      }
    } catch (error) {
      if (error instanceof PlexConnectionError) {
        throw error
      }
      throw new PlexConnectionError('UNREACHABLE', 'Musearr could not reach the Plex server.')
    } finally {
      clearTimeout(timeout)
    }
  }
}

/**
 * Rows of a Plex MediaContainer list. A missing list is empty, a list that is
 * not an array is an unreadable response, and non-object rows are skipped so a
 * stray null cannot become a raw TypeError.
 */
function plexRows<T extends object>(value: T[] | undefined): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new PlexConnectionError('INVALID_RESPONSE', 'Plex returned an unreadable response.')
  }
  return value.filter((row): row is T => typeof row === 'object' && row !== null)
}

async function plexTvRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)

  try {
    const response = await fetch(`${PLEX_TV_BASE_URL}${path}`, {
      redirect: 'error',
      ...init,
      headers: { ...PLEX_HEADERS, ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new PlexConnectionError('UNREACHABLE', 'Musearr could not reach plex.tv.')
    }
    return JSON.parse(await readBoundedResponse(response)) as T
  } catch (error) {
    if (error instanceof PlexConnectionError) {
      throw error
    }
    throw new PlexConnectionError('UNREACHABLE', 'Musearr could not reach plex.tv.')
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Starts a Plex PIN-based sign-in (https://plex.tv/api/v2/pins). The
 * returned code is embedded in the URL from {@link plexPinAuthUrl}; once the
 * user approves it at app.plex.tv, {@link checkPlexPin} resolves an
 * authToken scoped to their account.
 */
export async function createPlexPin(): Promise<PlexPin> {
  const payload = await plexTvRequest<{ id: number; code: string; authToken: string | null }>('/api/v2/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'strong=true',
  })
  if (!isRecord(payload) || typeof payload.id !== 'number' || typeof payload.code !== 'string') {
    throw new PlexConnectionError('INVALID_RESPONSE', 'plex.tv returned an unreadable sign-in code.')
  }
  return { id: payload.id, code: payload.code, authToken: typeof payload.authToken === 'string' ? payload.authToken : null }
}

export function plexPinAuthUrl(code: string): string {
  const clientId = encodeURIComponent(PLEX_HEADERS['X-Plex-Client-Identifier'])
  const product = encodeURIComponent(PLEX_HEADERS['X-Plex-Product'])
  return `https://app.plex.tv/auth#?clientID=${clientId}&code=${encodeURIComponent(code)}&context[device][product]=${product}`
}

export async function checkPlexPin(id: number): Promise<{ authToken: string | null }> {
  const payload = await plexTvRequest<{ authToken: string | null }>(`/api/v2/pins/${id}`)
  if (!isRecord(payload)) {
    throw new PlexConnectionError('INVALID_RESPONSE', 'plex.tv returned an unreadable sign-in status.')
  }
  return { authToken: typeof payload.authToken === 'string' ? payload.authToken : null }
}

/**
 * Lists the Plex Media Servers available to an account token, picking a
 * non-relay connection (preferring one on the local network) for each.
 */
export async function listPlexServersForToken(token: string): Promise<PlexAuthorizedServer[]> {
  const payload = await plexTvRequest<
    Array<{
      provides?: string
      name?: string
      clientIdentifier?: string
      connections?: Array<{ uri?: string; local?: boolean; relay?: boolean }>
    }>
  >('/api/v2/resources?includeHttps=1', {
    headers: { 'X-Plex-Token': token },
  })

  if (!Array.isArray(payload)) {
    throw new PlexConnectionError('INVALID_RESPONSE', 'plex.tv returned an unreadable server list.')
  }
  const servers: PlexAuthorizedServer[] = []
  for (const resource of payload) {
    if (!isRecord(resource)) {
      continue
    }
    const { provides, clientIdentifier, name } = resource
    if (typeof provides !== 'string' || !provides.split(',').includes('server') || typeof clientIdentifier !== 'string' || !clientIdentifier || typeof name !== 'string' || !name) {
      continue
    }
    const connections = Array.isArray(resource.connections) ? resource.connections.filter(isRecord) : []
    const preferred =
      connections.find((connection) => connection.local === true && connection.relay !== true) ??
      connections.find((connection) => connection.relay !== true) ??
      connections[0]
    if (typeof preferred?.uri !== 'string' || !preferred.uri) {
      continue
    }
    servers.push({ name, machineIdentifier: clientIdentifier, baseUrl: preferred.uri })
  }
  return servers
}

function normaliseTrack(
  item: NonNullable<NonNullable<PlexTrackResponse['MediaContainer']>['Metadata']>[number],
): PlexLibraryTrack[] {
  if (
    item.ratingKey === undefined ||
    !item.title ||
    item.parentRatingKey === undefined ||
    !item.parentTitle ||
    item.grandparentRatingKey === undefined ||
    !item.grandparentTitle
  ) {
    return []
  }

  return [
    {
      plexRatingKey: String(item.ratingKey),
      title: item.title,
      trackNumber: integerOrNull(item.index),
      discNumber: integerOrNull(item.parentIndex),
      durationMs: integerOrNull(item.duration),
      addedAt: timestampOrNull(item.addedAt),
      plexUpdatedAt: timestampOrNull(item.updatedAt),
      playCount: integerOrNull(item.viewCount) ?? 0,
      lastPlayedAt: timestampOrNull(item.lastViewedAt),
      rating: ratingOrNull(item.userRating),
      artist: {
        plexRatingKey: String(item.grandparentRatingKey),
        name: item.grandparentTitle,
        thumbKey: item.grandparentThumb ?? null,
      },
      album: {
        plexRatingKey: String(item.parentRatingKey),
        title: item.parentTitle,
        year: integerOrNull(item.parentYear),
        thumbKey: item.parentThumb ?? null,
      },
      genres: (item.Genre ?? [])
        .map((genre) => genre.tag?.trim())
        .filter((genre): genre is string => Boolean(genre)),
    },
  ]
}

/**
 * Builds the `server://` metadata URI Plex expects when seeding or extending a
 * playlist. Keys are the numeric track rating keys from the same server.
 */
function serverLibraryUri(machineIdentifier: string, ratingKeys: string[]): string {
  return `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function ratingOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1_000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}


// Caps decoded bytes too: Content-Length can be missing, wrong, or compressed.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new PlexConnectionError('INVALID_RESPONSE', 'Plex response exceeds the 16 MiB limit.')
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
        throw new PlexConnectionError('INVALID_RESPONSE', 'Plex response exceeds the 16 MiB limit.')
      }
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } finally {
    reader.releaseLock()
  }
}
