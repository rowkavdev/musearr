import { expect, test } from 'vitest'
import { formatDiscordDailyBrief } from './discord.js'

const prefixLength = formatDiscordDailyBrief({ headline: 'h', summary: '', cards: [] }).length

test('Discord briefing truncation never cuts an astral character in half', () => {
  const rendered = formatDiscordDailyBrief({
    headline: 'h', summary: 'x'.repeat(1899 - prefixLength) + '🎵 trailing text', cards: [],
  })
  expect(rendered.length).toBe(1899)
  expect(rendered.endsWith('x')).toBe(true)
  expect(rendered).not.toMatch(/[\ud800-\udbff]$/)
})

test('Discord briefing keeps an astral character ending exactly at the limit', () => {
  const rendered = formatDiscordDailyBrief({
    headline: 'h', summary: 'x'.repeat(1898 - prefixLength) + '🎵 trailing text', cards: [],
  })
  expect(rendered.length).toBe(1900)
  expect(rendered.endsWith('🎵')).toBe(true)
})

test('Discord briefing preserves the existing ASCII limit and short text', () => {
  const render = (summary: string) => formatDiscordDailyBrief({ headline: 'h', summary, cards: [] })
  expect(render('x'.repeat(2000)).length).toBe(1900)
  expect(render('short')).toBe('🎧 **Musearr daily brief**\n\n**h**\n\nshort')
})
