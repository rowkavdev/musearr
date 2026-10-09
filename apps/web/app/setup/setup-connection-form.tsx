'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { checkPinStatus, shouldRetryPinPoll } from './pin-poll'
import { runConnectionTest } from './test-connection'
import { useRouter } from 'next/navigation'

type MusicLibrary = { id: string; title: string; type: 'artist' }
type PlexConnection = {
  machineIdentifier: string
  serverName: string
  version: string | null
  musicLibraries: MusicLibrary[]
}

type PlexAuthorizedServer = { name: string; machineIdentifier: string; baseUrl: string }
type PlexPinCreateResponse = { id: number; code: string; authUrl: string }
type PlexPinStatusResponse = { authToken: string | null; servers: PlexAuthorizedServer[] }

type FormIssue = { detail?: string }

const initialForm = {
  baseUrl: 'http://host.docker.internal:32400',
  token: '',
  ownerUsername: '',
  ownerPassword: '',
}

const PIN_POLL_INTERVAL_MS = 2_000
const PIN_TIMEOUT_MS = 2 * 60 * 1_000

async function getIssue(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as FormIssue
    return body.detail ?? 'Musearr could not complete that request.'
  } catch {
    return 'Musearr could not complete that request.'
  }
}

export function SetupConnectionForm() {
  const router = useRouter()
  const [form, setForm] = useState(initialForm)
  const [connection, setConnection] = useState<PlexConnection | null>(null)
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([])
  const [state, setState] = useState<'idle' | 'testing' | 'saving' | 'complete'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const [pinState, setPinState] = useState<'idle' | 'waiting' | 'error'>('idle')
  const [pinMessage, setPinMessage] = useState<string | null>(null)
  const [availableServers, setAvailableServers] = useState<PlexAuthorizedServer[]>([])
  const pollHandle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollGeneration = useRef(0)
  // Synchronous Test connection invalidation: every path that replaces the
  // address or token bumps this before any pending response can be applied.
  const testGeneration = useRef(0)

  useEffect(() => {
    return () => {
      pollGeneration.current += 1
      if (pollHandle.current) {
        clearTimeout(pollHandle.current)
      }
    }
  }, [])

  function updateField(field: keyof typeof initialForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
    if (field === 'baseUrl' || field === 'token') {
      testGeneration.current += 1
      setConnection(null)
      setSelectedLibraryIds([])
    }
    setMessage(null)
  }

  function stopPinPolling() {
    pollGeneration.current += 1
    if (pollHandle.current) {
      clearTimeout(pollHandle.current)
      pollHandle.current = null
    }
  }

  async function signInWithPlex() {
    stopPinPolling()
    setAvailableServers([])
    setPinState('waiting')
    setPinMessage('Waiting for you to approve Musearr on plex.tv…')

    let pin: PlexPinCreateResponse
    try {
      const response = await fetch('/api/v1/setup/plex-pin', { method: 'POST' })
      if (!response.ok) {
        throw new Error(await getIssue(response))
      }
      pin = (await response.json()) as PlexPinCreateResponse
    } catch (error) {
      setPinState('error')
      setPinMessage(error instanceof Error ? error.message : 'Musearr could not start Plex sign-in.')
      return
    }

    const popup = window.open(pin.authUrl, 'musearr-plex-signin', 'width=480,height=720')
    if (!popup) {
      setPinMessage('Approve Musearr for your Plex account, then come back here — this tab is waiting.')
    }

    const generation = ++pollGeneration.current
    const deadline = Date.now() + PIN_TIMEOUT_MS
    let consecutiveFailures = 0

    const poll = async () => {
      if (generation !== pollGeneration.current) {
        return
      }
      if (Date.now() > deadline) {
        setPinState('error')
        setPinMessage('Plex sign-in timed out. Try again.')
        return
      }

      let failedStatus: number | null = null
      try {
        const check = await checkPinStatus(fetch, `/api/v1/setup/plex-pin/${pin.id}`, getIssue)
        if (!check.ok) {
          failedStatus = check.status
          throw new Error(check.message ?? 'Musearr could not check Plex sign-in status.')
        }
        consecutiveFailures = 0
        const status = check.value
        if (generation !== pollGeneration.current) {
          return
        }

        if (!status.authToken) {
          pollHandle.current = setTimeout(poll, PIN_POLL_INTERVAL_MS)
          return
        }

        popup?.close()
        setPinState('idle')
        testGeneration.current += 1
        setForm((current) => ({
          ...current,
          token: status.authToken as string,
          baseUrl: status.servers[0]?.baseUrl ?? current.baseUrl,
        }))
        setConnection(null)
        setSelectedLibraryIds([])

        if (status.servers.length === 0) {
          setPinMessage("Signed in, but Plex didn't return a server for this account — check the address and use Test connection.")
          setAvailableServers([])
        } else if (status.servers.length === 1) {
          setPinMessage(`Signed in. Using ${status.servers[0]?.name ?? 'your Plex server'} — test the connection below.`)
          setAvailableServers([])
        } else {
          setPinMessage('Signed in. Choose which Plex server to use, then test the connection.')
          setAvailableServers(status.servers)
        }
      } catch (error) {
        if (generation !== pollGeneration.current) {
          return
        }
        consecutiveFailures += 1
        // A brief plex.tv or network hiccup should not throw away an approval the user is giving.
        if (shouldRetryPinPoll(failedStatus, consecutiveFailures)) {
          pollHandle.current = setTimeout(poll, PIN_POLL_INTERVAL_MS)
          return
        }
        setPinState('error')
        setPinMessage(error instanceof Error ? error.message : 'Musearr could not check Plex sign-in status.')
      }
    }

    void poll()
  }

  function chooseServer(machineIdentifier: string) {
    const server = availableServers.find((candidate) => candidate.machineIdentifier === machineIdentifier)
    if (!server) {
      return
    }
    testGeneration.current += 1
    setForm((current) => ({ ...current, baseUrl: server.baseUrl }))
    setConnection(null)
    setSelectedLibraryIds([])
  }

  async function testConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('testing')
    setMessage(null)
    const generation = testGeneration.current

    try {
      await runConnectionTest({
        fetchImpl: fetch,
        details: { baseUrl: form.baseUrl, token: form.token },
        isCurrent: () => generation === testGeneration.current,
        readIssue: getIssue,
        onVerified: (result) => {
          setConnection(result)
          setSelectedLibraryIds(result.musicLibraries.map((library) => library.id))
          setMessage(`Connected to ${result.serverName}. Choose the music libraries Musearr should understand.`)
        },
        onFailure: setMessage,
      })
    } finally {
      setState('idle')
    }
  }

  function toggleLibrary(libraryId: string) {
    setSelectedLibraryIds((current) =>
      current.includes(libraryId)
        ? current.filter((id) => id !== libraryId)
        : [...current, libraryId],
    )
    setMessage(null)
  }

  async function saveSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection || selectedLibraryIds.length === 0) {
      setMessage('Choose at least one Plex music library before continuing.')
      return
    }

    setState('saving')
    setMessage(null)
    try {
      const response = await fetch('/api/v1/setup/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, selectedLibraryIds }),
      })
      if (!response.ok) {
        throw new Error(await getIssue(response))
      }
      setForm((current) => ({ ...current, token: '', ownerPassword: '' }))
      setState('complete')
      setMessage('Your music room is ready. Musearr will prepare your first sync next.')
      window.setTimeout(() => router.push('/'), 900)
    } catch (error) {
      setState('idle')
      setMessage(error instanceof Error ? error.message : 'Musearr could not save this connection.')
    }
  }

  return (
    <div>
      <div className="setup-card__heading">
        <div className="setup-card__icon" aria-hidden="true">P</div>
        <div>
          <h2>Connect Plex</h2>
          <p>Test the connection before Musearr stores it.</p>
        </div>
      </div>

      <button
        className="plex-signin-button"
        disabled={pinState === 'waiting'}
        onClick={() => void signInWithPlex()}
        type="button"
      >
        {pinState === 'waiting' ? 'Waiting for Plex…' : 'Sign in with Plex'}
      </button>
      {pinMessage && (
        <p className={pinState === 'error' ? 'form-message' : 'form-message form-message--success'} role="status">
          {pinMessage}
        </p>
      )}
      {availableServers.length > 1 && (
        <label className="server-picker">
          Plex server
          <select onChange={(event) => chooseServer(event.target.value)} value="">
            <option disabled value="">
              Choose a server…
            </option>
            {availableServers.map((server) => (
              <option key={server.machineIdentifier} value={server.machineIdentifier}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="form-divider">or enter it manually</div>

      <form className="connection-form" onSubmit={testConnection}>
        <label>
          Plex server address
          <input
            autoComplete="url"
            inputMode="url"
            onChange={(event) => updateField('baseUrl', event.target.value)}
            placeholder="http://plex.local:32400"
            required
            type="url"
            value={form.baseUrl}
          />
          <span className="field-hint">Use the server address available from this Musearr host.</span>
        </label>
        <label>
          Plex token
          <input
            autoComplete="off"
            onChange={(event) => updateField('token', event.target.value)}
            placeholder="Your Plex token"
            required
            type="password"
            value={form.token}
          />
          <span className="field-hint">Encrypted at rest; never returned to this browser.</span>
        </label>
        <button className="secondary-button" disabled={state !== 'idle'} type="submit">
          {state === 'testing' ? 'Testing connection…' : 'Test connection'}
        </button>
      </form>

      {connection && (
        <form className="connection-form connection-form--complete" onSubmit={saveSetup}>
          <div className="verified-server">
            <span className="verified-server__check" aria-hidden="true">✓</span>
            <span>
              <strong>{connection.serverName}</strong>
              <small>{connection.version ? `Plex Media Server ${connection.version}` : 'Plex Media Server'}</small>
            </span>
          </div>
          <fieldset>
            <legend>Music libraries to include</legend>
            {connection.musicLibraries.length === 0 ? (
              <p className="empty-library-note">Plex did not return a music library for this token.</p>
            ) : (
              <div className="library-options">
                {connection.musicLibraries.map((library) => (
                  <label className="library-option" key={library.id}>
                    <input
                      checked={selectedLibraryIds.includes(library.id)}
                      onChange={() => toggleLibrary(library.id)}
                      type="checkbox"
                    />
                    <span>{library.title}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="owner-fields">
            <label>
              Local owner name
              <input
                autoComplete="username"
                minLength={3}
                onChange={(event) => updateField('ownerUsername', event.target.value)}
                placeholder="musicroom"
                required
                value={form.ownerUsername}
              />
            </label>
            <label>
              Local owner password
              <input
                autoComplete="new-password"
                minLength={12}
                onChange={(event) => updateField('ownerPassword', event.target.value)}
                placeholder="At least 12 characters"
                required
                type="password"
                value={form.ownerPassword}
              />
            </label>
          </div>
          <button className="primary-button" disabled={state !== 'idle'} type="submit">
            {state === 'saving' ? 'Saving securely…' : state === 'complete' ? 'All set' : 'Save and begin'}
          </button>
        </form>
      )}

      {message && <p className={connection ? 'form-message form-message--success' : 'form-message'} role="status">{message}</p>}
    </div>
  )
}
