import { expect, test } from 'vitest'
import { OllamaLocalAiProvider } from './ollama.js'

for (const scenario of ['reachable', 'declared', 'chunked', 'http-error'] as const) {
  for (const mode of ['pending', 'throw', 'reject'] as const) {
    test(`Ollama ${scenario} result does not wait for or get replaced by ${mode} cleanup`, async () => {
      let cancelled = false
      let released = false
      const cancel = () => {
        cancelled = true
        if (mode === 'throw') throw new Error('cleanup failed')
        if (mode === 'reject') return Promise.reject(new Error('cleanup failed'))
        return new Promise<void>(() => {})
      }
      // Deliberately broken upstream adapter; no actual Ollama server is used.
      const fetchImpl = (async () => ({
        ok: scenario !== 'http-error', status: scenario === 'http-error' ? 503 : 200,
        headers: new Headers(scenario === 'declared' ? { 'content-length': String(17 * 1024 * 1024) } : {}),
        body: {
          cancel,
          getReader: () => ({
            read: async () => ({ done: false, value: new Uint8Array(16 * 1024 * 1024 + 1) }),
            cancel,
            releaseLock: () => { released = true },
          }),
        },
      })) as unknown as typeof fetch
      const provider = new OllamaLocalAiProvider({ baseUrl: 'http://ollama.local', model: 'fixture', fetchImpl })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const operation = scenario === 'reachable' ? provider.isReachable() : provider.complete({ prompt: 'fixture' })
        const outcome = await Promise.race([
          operation.then(value => ({ value }), error => ({ error: String(error) })),
          new Promise<{ timeout: true }>(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 100) }),
        ])
        if (scenario === 'reachable') expect(outcome).toEqual({ value: true })
        else expect(outcome).toEqual({ error: expect.stringMatching(scenario === 'http-error' ? /HTTP 503/ : /16 MiB limit/) })
        expect(cancelled).toBe(true)
        if (scenario === 'chunked') expect(released).toBe(true)
      } finally {
        clearTimeout(timer)
      }
    })
  }
}
