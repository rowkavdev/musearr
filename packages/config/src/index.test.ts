import { describe, expect, it } from 'vitest'
import { getConfig } from './index.js'

describe('getConfig', () => {
  it('normalises the browser origin and defaults proxy trust to false', () => {
    const config = getConfig({ MUSEARR_WEB_ORIGIN: 'https://musearr.local/setup' })

    expect(config.MUSEARR_WEB_ORIGIN).toBe('https://musearr.local')
    expect(config.MUSEARR_TRUST_PROXY).toBe(false)
    expect(config.MUSEARR_RECONCILIATION_INTERVAL_MINUTES).toBe(360)
    expect(config.MUSEARR_TIMEZONE).toBe('UTC')
    expect(config.MUSEARR_DAILY_BRIEF_TIME).toBe('08:00')
  })

  it('accepts proxy trust only when it is explicitly enabled', () => {
    const config = getConfig({ MUSEARR_TRUST_PROXY: 'true' })

    expect(config.MUSEARR_TRUST_PROXY).toBe(true)
  })

  it('treats empty optional webhook configuration as disabled for Docker Compose', () => {
    expect(getConfig({ MUSEARR_PLEX_WEBHOOK_SECRET: '', MUSEARR_DISCORD_WEBHOOK_URL: '' })).toMatchObject({
      MUSEARR_PLEX_WEBHOOK_SECRET: undefined,
      MUSEARR_DISCORD_WEBHOOK_URL: undefined,
    })
  })

  it('rejects a non-HTTP browser origin', () => {
    expect(() => getConfig({ MUSEARR_WEB_ORIGIN: 'file:///musearr' })).toThrow()
  })

  it('rejects an unsupported reconciliation interval', () => {
    expect(() => getConfig({ MUSEARR_RECONCILIATION_INTERVAL_MINUTES: '45' })).toThrow()
  })

  it('validates daily briefing timezone, time, and Discord webhook configuration', () => {
    expect(
      getConfig({
        MUSEARR_TIMEZONE: 'Europe/London',
        MUSEARR_DAILY_BRIEF_TIME: '07:30',
        MUSEARR_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456/token',
      }),
    ).toMatchObject({ MUSEARR_TIMEZONE: 'Europe/London', MUSEARR_DAILY_BRIEF_TIME: '07:30' })
    expect(() => getConfig({ MUSEARR_TIMEZONE: 'not/a-timezone' })).toThrow()
    expect(() => getConfig({ MUSEARR_DAILY_BRIEF_TIME: '7:30' })).toThrow()
    expect(() => getConfig({ MUSEARR_DISCORD_WEBHOOK_URL: 'https://example.test/hooks/123' })).toThrow()
    expect(() => getConfig({ MUSEARR_DISCORD_WEBHOOK_URL: 'https://user:pass@discord.com/api/webhooks/123/token' })).toThrow()
  })

  it('rejects an encryption key that is not a base64 32-byte value', () => {
    const hex = 'a'.repeat(64)
    for (const bad of ['short', hex, Buffer.alloc(16).toString('base64'), Buffer.alloc(48).toString('base64')]) {
      expect(() => getConfig({ MUSEARR_ENCRYPTION_KEY: bad })).toThrow(/MUSEARR_ENCRYPTION_KEY/)
    }
  })

  it('accepts a base64 32-byte encryption key and an unset one', () => {
    const key = Buffer.alloc(32, 7).toString('base64')
    expect(getConfig({ MUSEARR_ENCRYPTION_KEY: key }).MUSEARR_ENCRYPTION_KEY).toBe(key)
    expect(getConfig({}).MUSEARR_ENCRYPTION_KEY).toBeUndefined()
  })
})
