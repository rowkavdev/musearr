'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { readDailyBrief } from './daily-brief-reply'
import { queueLibrarySync } from './queue-sync'

type Recommendation = {
  runId: string
  createdAt: string
  trackTitle: string
  artistName: string
  albumTitle: string
  rank: number
  summary: string
}

type DashboardOverview = {
  library: {
    artistCount: number
    albumCount: number
    trackCount: number
    totalDurationMs: number
    newestAddedAt: string | null
  }
  listening: {
    totalPlayCount: number
    playedTrackCount: number
    ratedTrackCount: number
    lastPlayedAt: string | null
  }
  favourites: {
    artists: Array<{ id: string; name: string; playCount: number }>
    genres: Array<{ id: string; name: string; playCount: number }>
  }
  sync: {
    status: 'not_started' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    lastCompletedAt: string | null
    errorSummary: string | null
  }
  dailyMix: Recommendation[]
}

type DailyBrief = {
  id: string
  briefDate: string
  timezone: string
  content: {
    headline: string
    summary: string
    cards: Array<{
      kind: 'daily_mix' | 'favourite_artist' | 'favourite_genre' | 'library' | 'sync'
      title: string
      body: string
    }>
  }
  createdAt: string
  discordDelivery: {
    status: 'pending' | 'delivered' | 'failed'
    attemptCount: number
    lastAttemptAt: string | null
    deliveredAt: string | null
    errorSummary: string | null
  } | null
}

type ViewState = 'loading' | 'ready' | 'unconfigured' | 'signed_out' | 'unavailable'

const startingMixes = [
  {
    name: 'Daily Mix',
    note: 'A little familiar, a little unexpected',
    hue: 'rose',
  },
  {
    name: 'Forgotten Favourites',
    note: 'Albums you used to know by heart',
    hue: 'violet',
  },
  {
    name: 'Hidden Gems',
    note: 'The overlooked corners of your library',
    hue: 'teal',
  },
]

export function DashboardHome() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [dailyBrief, setDailyBrief] = useState<DailyBrief | null>(null)
  const [viewState, setViewState] = useState<ViewState>('loading')
  const [generationState, setGenerationState] = useState<'idle' | 'queueing' | 'queued' | 'failed'>('idle')
  const [briefGenerationState, setBriefGenerationState] = useState<'idle' | 'queueing' | 'queued' | 'failed'>('idle')

  useEffect(() => {
    const controller = new AbortController()

    async function loadDashboard() {
      try {
        const dashboardRequest = fetch('/api/v1/dashboard', {
          signal: controller.signal,
        })
        const briefRequest = fetch('/api/v1/daily-briefs/latest', {
          signal: controller.signal,
        }).catch(() => null)
        const response = await dashboardRequest
        if (response.ok) {
          setOverview((await response.json()) as DashboardOverview)
          setViewState('ready')
          setDailyBrief(await readDailyBrief<DailyBrief>(briefRequest))
          return
        }
        if (response.status !== 401) {
          setViewState('unavailable')
          return
        }

        const setupResponse = await fetch('/api/v1/setup/status', {
          signal: controller.signal,
        })
        const setup = setupResponse.ok ? ((await setupResponse.json()) as { phase?: string }) : null
        setViewState(setup?.phase === 'configured' ? 'signed_out' : 'unconfigured')
      } catch {
        if (!controller.signal.aborted) {
          setViewState('unavailable')
        }
      }
    }

    void loadDashboard()
    return () => controller.abort()
  }, [])

  async function generateDailyMix() {
    setGenerationState('queueing')
    try {
      const response = await fetch('/api/v1/recommendations/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'daily_mix', limit: 20 }),
      })
      if (!response.ok) {
        throw new Error('Musearr could not queue a Daily Mix.')
      }
      setGenerationState('queued')
    } catch {
      setGenerationState('failed')
    }
  }

  async function generateDailyBrief() {
    setBriefGenerationState('queueing')
    try {
      const response = await fetch('/api/v1/daily-briefs/generate', { method: 'POST' })
      if (!response.ok) {
        throw new Error('Musearr could not queue a daily briefing.')
      }
      setBriefGenerationState('queued')
    } catch {
      setBriefGenerationState('failed')
    }
  }

  if (viewState === 'ready' && overview) {
    return (
      <ListeningDashboard
        overview={overview}
        dailyBrief={dailyBrief}
        generationState={generationState}
        briefGenerationState={briefGenerationState}
        onGenerate={generateDailyMix}
        onGenerateBrief={generateDailyBrief}
      />
    )
  }

  return <StartingDashboard state={viewState} />
}

function StartingDashboard({ state }: { state: ViewState }) {
  const signedOut = state === 'signed_out'
  const unavailable = state === 'unavailable'
  const link = signedOut ? '/login' : unavailable ? '/' : '/setup'
  const action = signedOut ? 'Sign in' : unavailable ? 'Refresh page' : 'Connect Plex'
  const description = signedOut
    ? 'Sign in with your local Musearr account to return to your private listening dashboard.'
    : unavailable
      ? 'Start the local API and PostgreSQL service, then return here to explore your library.'
      : 'Connect Plex and Musearr will turn your collection into a living, private listening companion—one thoughtful recommendation at a time.'

  return (
    <>
      <section className="welcome-section" aria-labelledby="welcome-title">
        <div>
          <p className="eyebrow">
            {signedOut ? 'WELCOME BACK' : unavailable ? 'LOCAL SERVICE OFFLINE' : 'WELCOME HOME'}
          </p>
          <h1 id="welcome-title">{signedOut ? 'Your music is waiting.' : 'Music that remembers you.'}</h1>
          <p className="welcome-copy">{description}</p>
          <Link className="primary-button" href={link}>
            {action} <span aria-hidden="true">→</span>
          </Link>
        </div>
        <HeroArt />
      </section>

      <section className="section-block" aria-labelledby="mixes-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">STARTING SOON</p>
            <h2 id="mixes-title">Your mixes will live here</h2>
          </div>
          <span className="quiet-label">Built from your library, never a black box.</span>
        </div>
        <div className="mix-grid">
          {startingMixes.map((mix, index) => (
            <article className="mix-card" key={mix.name}>
              <div className={`mix-art mix-art--${mix.hue}`} aria-hidden="true">
                <span className="mix-art__number">0{index + 1}</span>
                <span className="mix-art__shape mix-art__shape--one" />
                <span className="mix-art__shape mix-art__shape--two" />
              </div>
              <div className="mix-card__copy">
                <h3>{mix.name}</h3>
                <p>{mix.note}</p>
                <span className="card-pending">Waiting for your library</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}

function ListeningDashboard({
  overview,
  dailyBrief,
  generationState,
  briefGenerationState,
  onGenerate,
  onGenerateBrief,
}: {
  overview: DashboardOverview
  dailyBrief: DailyBrief | null
  generationState: 'idle' | 'queueing' | 'queued' | 'failed'
  briefGenerationState: 'idle' | 'queueing' | 'queued' | 'failed'
  onGenerate: () => void
  onGenerateBrief: () => void
}) {
  const dailyMix = overview.dailyMix.slice(0, 5)
  const hasMix = dailyMix.length > 0

  return (
    <>
      <section className="welcome-section" aria-labelledby="listening-title">
        <div>
          <p className="eyebrow">YOUR MUSIC ROOM</p>
          <h1 id="listening-title">A little closer to your next favourite.</h1>
          <p className="welcome-copy">
            {overview.library.trackCount > 0
              ? `${formatNumber(overview.library.trackCount)} tracks from ${formatNumber(overview.library.artistCount)} artists are ready to rediscover.`
              : 'Your first Plex sync is under way. This view will become personal as soon as tracks arrive.'}
          </p>
          <button
            className="primary-button"
            disabled={generationState === 'queueing'}
            onClick={onGenerate}
            type="button"
          >
            {generationState === 'queueing'
              ? 'Preparing your mix…'
              : generationState === 'queued'
                ? 'Daily Mix queued'
                : 'Refresh Daily Mix'}{' '}
            <span aria-hidden="true">→</span>
          </button>
          {generationState === 'failed' && (
            <p className="hero-message">Musearr could not queue a mix. Try again shortly.</p>
          )}
          {generationState === 'queued' && (
            <p className="hero-message">The worker will create it locally; refresh this page in a moment.</p>
          )}
        </div>
        <HeroArt />
      </section>

      <section className="section-block" aria-labelledby="library-pulse-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LISTENING PULSE</p>
            <h2 id="library-pulse-title">Your library, in focus</h2>
          </div>
          <span className="quiet-label">Calculated from your local Plex mirror.</span>
        </div>
        <div className="intelligence-grid">
          <StatCard
            label="Tracks"
            value={formatNumber(overview.library.trackCount)}
            note={
              overview.library.newestAddedAt
                ? `Newest addition ${formatDate(overview.library.newestAddedAt)}`
                : 'Waiting for library dates'
            }
          />
          <StatCard
            label="Listening time"
            value={formatDuration(overview.library.totalDurationMs)}
            note={`${formatNumber(overview.library.albumCount)} albums in your room`}
          />
          <StatCard
            label="Reported plays"
            value={formatNumber(overview.listening.totalPlayCount)}
            note={
              overview.listening.lastPlayedAt
                ? `Last played ${formatDate(overview.listening.lastPlayedAt)}`
                : 'Plex has not reported a play yet'
            }
          />
          <StatCard
            label="Rated tracks"
            value={formatNumber(overview.listening.ratedTrackCount)}
            note={`${formatNumber(overview.listening.playedTrackCount)} tracks played`}
          />
        </div>
      </section>

      <section className="section-block" aria-labelledby="daily-mix-title" id="daily-mix">
        <div className="section-heading">
          <div>
            <p className="eyebrow">EXPLAINABLE DAILY MIX</p>
            <h2 id="daily-mix-title">{hasMix ? 'For this moment' : 'Ready when you are'}</h2>
          </div>
          {hasMix && <span className="quiet-label">Generated {formatDate(dailyMix[0]?.createdAt ?? '')}</span>}
        </div>
        {hasMix ? (
          <div className="recommendation-list">
            {dailyMix.map((recommendation) => (
              <article className="recommendation-row" key={`${recommendation.runId}-${recommendation.rank}`}>
                <span className="recommendation-rank">{String(recommendation.rank).padStart(2, '0')}</span>
                <div className="recommendation-song">
                  <strong>{recommendation.trackTitle}</strong>
                  <span>
                    {recommendation.artistName} · {recommendation.albumTitle}
                  </span>
                </div>
                <p>{recommendation.summary}</p>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-intelligence">
            <strong>No Daily Mix has been saved yet.</strong>
            <span>Generate one after your library sync finishes. Every track will include a factual reason.</span>
          </div>
        )}
      </section>

      <DailyBriefPanel
        brief={dailyBrief}
        generationState={briefGenerationState}
        onGenerate={onGenerateBrief}
      />

      <section className="dashboard-split" aria-label="Favourite artists, genres, and sync status">
        <InsightCard
          eyebrow="FAVOURITE ARTISTS"
          title="Who you return to"
          values={overview.favourites.artists}
          empty="Play data from Plex will reveal your familiar artists here."
        />
        <InsightCard
          eyebrow="FAVOURITE GENRES"
          title="Your current texture"
          values={overview.favourites.genres}
          empty="Genre affinity appears after Musearr sees plays in your library."
          tone="violet"
        />
        <SyncStateCard sync={overview.sync} />
      </section>
    </>
  )
}

function SyncStateCard({ sync }: { sync: DashboardOverview['sync'] }) {
  const [syncRequest, setSyncRequest] = useState<'idle' | 'queueing' | 'queued' | 'signed_out' | 'failed'>('idle')
  const isActive = sync.status === 'queued' || sync.status === 'running'
  const isFailure = sync.status === 'failed'

  return (
    <article
      className={`insight-card insight-card--green sync-state-card sync-state-card--${sync.status}`}
      aria-live={isActive || isFailure ? 'polite' : undefined}
    >
      <div className="sync-state-card__heading">
        <p className="eyebrow">LIBRARY CARE</p>
        <span className="sync-state-badge">{syncStatusLabel(sync.status)}</span>
      </div>
      <h2>{syncHeading(sync.status)}</h2>
      <p className="insight-card__copy">{syncSummary(sync)}</p>
      {sync.lastCompletedAt ? (
        <p className="sync-state-card__timestamp">Last completed {formatDate(sync.lastCompletedAt)}</p>
      ) : null}
      {!isActive ? (
        <button
          className="secondary-button"
          disabled={syncRequest === 'queueing' || syncRequest === 'queued'}
          onClick={async () => {
            setSyncRequest('queueing')
            setSyncRequest(await queueLibrarySync(() => fetch('/api/v1/sync', { method: 'POST' })))
          }}
          type="button"
        >
          {syncRequest === 'queueing' ? 'Queueing…' : syncRequest === 'queued' ? 'Sync queued' : 'Sync library now'}
        </button>
      ) : null}
      {syncRequest === 'queued' ? <p className="sync-state-card__timestamp">Sync queued. Refresh in a minute to see progress.</p> : null}
      {syncRequest === 'signed_out' ? <p className="sync-state-card__timestamp">Sign in again to start a sync.</p> : null}
      {syncRequest === 'failed' ? <p className="sync-state-card__timestamp">Musearr could not queue a sync. Try again shortly.</p> : null}
    </article>
  )
}

function syncStatusLabel(status: DashboardOverview['sync']['status']): string {
  switch (status) {
    case 'not_started': return 'Not started'
    case 'queued': return 'Queued'
    case 'running': return 'Syncing'
    case 'completed': return 'Up to date'
    case 'failed': return 'Needs attention'
    case 'cancelled': return 'Cancelled'
  }
}

function syncSummary(sync: DashboardOverview['sync']): string {
  if (sync.status === 'failed') {
    return sync.errorSummary ?? 'The last library sync did not finish. Check your Plex connection, then sync again.'
  }

  switch (sync.status) {
    case 'queued': return 'Your library sync is waiting to start. This dashboard will refresh when it finishes.'
    case 'running': return 'Your library is being reconciled now. Keep this page open or return later for refreshed results.'
    case 'completed': return sync.lastCompletedAt ? 'Your library mirror is current. Scheduled reconciliation keeps it fresh.' : 'Your library mirror is current.'
    case 'cancelled': return 'The last library sync was cancelled. Sync again when you are ready.'
    case 'not_started': return 'No library sync has started yet. Your library and listening insights will appear after the first sync.'
  }
}

function DailyBriefPanel({
  brief,
  generationState,
  onGenerate,
}: {
  brief: DailyBrief | null
  generationState: 'idle' | 'queueing' | 'queued' | 'failed'
  onGenerate: () => void
}) {
  return (
    <section className="section-block" aria-labelledby="daily-brief-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DAILY INTELLIGENCE</p>
          <h2 id="daily-brief-title">Your private morning note</h2>
        </div>
        {brief ? <span className="quiet-label">Prepared {formatDate(brief.createdAt)}</span> : null}
      </div>
      {brief ? (
        <article className="daily-brief-card">
          <div className="daily-brief-card__intro">
            <div>
              <h3>{brief.content.headline}</h3>
              <p>{brief.content.summary}</p>
            </div>
            <span className={`delivery-state delivery-state--${brief.discordDelivery?.status ?? 'local'}`}>
              {deliveryLabel(brief.discordDelivery)}
            </span>
          </div>
          <div className="daily-brief-card__items">
            {brief.content.cards.map((card) => (
              <article className="daily-brief-item" key={`${card.kind}-${card.title}`}>
                <span className="daily-brief-item__kind">{briefCardLabel(card.kind)}</span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        </article>
      ) : (
        <div className="empty-intelligence">
          <strong>Your first daily briefing is ready to be made.</strong>
          <span>It will be saved locally before any optional Discord delivery, using only the facts in your Plex mirror.</span>
          <button className="secondary-button" disabled={generationState === 'queueing'} onClick={onGenerate} type="button">
            {generationState === 'queueing'
              ? 'Preparing your briefing…'
              : generationState === 'queued'
                ? 'Daily briefing queued'
                : 'Create today’s briefing'}
          </button>
          {generationState === 'failed' ? <span>Could not queue the briefing. Try again shortly.</span> : null}
          {generationState === 'queued' ? <span>The local worker is preparing it now; refresh this page in a moment.</span> : null}
        </div>
      )}
    </section>
  )
}

function StatCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  )
}

function InsightCard({
  eyebrow,
  title,
  values,
  empty,
  tone,
}: {
  eyebrow: string
  title: string
  values: Array<{ id: string; name: string; playCount: number }>
  empty: string
  tone?: 'violet'
}) {
  return (
    <article className={`insight-card${tone ? ` insight-card--${tone}` : ''}`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {values.length === 0 ? (
        <p className="insight-card__copy">{empty}</p>
      ) : (
        <ol className="favourite-list">
          {values.map((value) => (
            <li key={value.id}>
              <span>{value.name}</span>
              <small>{formatNumber(value.playCount)} plays</small>
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

function HeroArt() {
  return (
    <div className="hero-art" aria-hidden="true">
      <div className="hero-art__sun" />
      <div className="hero-art__arc hero-art__arc--one" />
      <div className="hero-art__arc hero-art__arc--two" />
      <div className="hero-art__orb hero-art__orb--one" />
      <div className="hero-art__orb hero-art__orb--two" />
      <div className="hero-art__line" />
    </div>
  )
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}
function formatDuration(value: number): string {
  const totalMinutes = Math.floor(value / 60_000)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${formatNumber(hours)}h ${minutes}m` : `${formatNumber(hours)}h`
}
function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'recently'
    : new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(date)
}
function syncHeading(status: DashboardOverview['sync']['status']): string {
  switch (status) {
    case 'completed':
      return 'Library is in sync'
    case 'running':
      return 'Syncing your library'
    case 'queued':
      return 'Sync is queued'
    case 'failed':
      return 'Sync needs attention'
    case 'cancelled':
      return 'Sync was cancelled'
    case 'not_started':
      return 'First sync is waiting'
  }
}

function deliveryLabel(delivery: DailyBrief['discordDelivery']): string {
  if (!delivery) return 'Saved locally'
  if (delivery.status === 'delivered') return 'Discord delivered'
  if (delivery.status === 'failed') return 'Discord needs attention'
  return 'Discord delivery pending'
}

function briefCardLabel(kind: DailyBrief['content']['cards'][number]['kind']): string {
  switch (kind) {
    case 'daily_mix':
      return 'START HERE'
    case 'favourite_artist':
      return 'FAVOURITE ARTIST'
    case 'favourite_genre':
      return 'FAVOURITE GENRE'
    case 'library':
      return 'YOUR LIBRARY'
    case 'sync':
      return 'SYSTEM STATUS'
  }
}
