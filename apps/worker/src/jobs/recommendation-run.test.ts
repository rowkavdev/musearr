import { beforeEach, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  beginRecommendationRun: vi.fn(),
  completeRecommendationRun: vi.fn(),
  failRecommendationRun: vi.fn(),
  getRecommendationCandidates: vi.fn(),
}))
vi.mock('@musearr/db', () => db)
const intelligence = vi.hoisted(() => ({ rankRecommendations: vi.fn() }))
vi.mock('@musearr/intelligence', () => ({
  rankRecommendations: intelligence.rankRecommendations,
  RECOMMENDATION_ALGORITHM_VERSION: 'test-v1',
}))
const { generateRecommendationRun } = await import('./recommendation-run.js')
const database = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  db.getRecommendationCandidates.mockResolvedValue([{ trackId: 't1' }])
  db.beginRecommendationRun.mockResolvedValue('run-1')
})

it('stores ranked recommendations with one-based ranks', async () => {
  intelligence.rankRecommendations.mockReturnValue([
    { trackId: 't2', score: 0.9, reasons: ['a'], summary: 'first' },
    { trackId: 't1', score: 0.5, reasons: ['b'], summary: 'second' },
  ])

  await expect(generateRecommendationRun(database, 'user-1', 'daily_mix', 2)).resolves.toEqual({
    runId: 'run-1',
    recommendationCount: 2,
  })
  expect(db.beginRecommendationRun).toHaveBeenCalledWith(database, 'user-1', 'daily_mix', 'test-v1')
  expect(intelligence.rankRecommendations).toHaveBeenCalledWith([{ trackId: 't1' }], 'daily_mix', { limit: 2 })
  expect(db.completeRecommendationRun).toHaveBeenCalledWith(database, 'run-1', [
    { trackId: 't2', rank: 1, score: 0.9, reasons: ['a'], summary: 'first' },
    { trackId: 't1', rank: 2, score: 0.5, reasons: ['b'], summary: 'second' },
  ])
  expect(db.failRecommendationRun).not.toHaveBeenCalled()
})

it('records the failure and rethrows so the queue can retry', async () => {
  intelligence.rankRecommendations.mockImplementation(() => { throw new Error('ranking broke') })

  await expect(generateRecommendationRun(database, 'user-1', 'hidden_gems', 5)).rejects.toThrow('ranking broke')
  expect(db.failRecommendationRun).toHaveBeenCalledWith(database, 'run-1', 'ranking broke')
  expect(db.completeRecommendationRun).not.toHaveBeenCalled()
})

it('gives a generic message when a non-Error is thrown', async () => {
  intelligence.rankRecommendations.mockImplementation(() => { throw 'boom' })

  await expect(generateRecommendationRun(database, 'user-1', 'daily_mix', 5)).rejects.toBe('boom')
  expect(db.failRecommendationRun).toHaveBeenCalledWith(database, 'run-1', 'Unknown recommendation error')
})
