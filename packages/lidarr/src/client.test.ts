import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LidarrClient, LidarrConnectionError, normaliseLidarrBaseUrl } from './client.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('normaliseLidarrBaseUrl', () => {
  it('keeps a bare origin and strips a trailing slash', () => {
    expect(normaliseLidarrBaseUrl('http://lidarr.local:8686/')).toBe('http://lidarr.local:8686')
  })

  it('rejects credentials, query strings, and non-http schemes', () => {
    expect(() => normaliseLidarrBaseUrl('http://user:pass@lidarr.local')).toThrow(LidarrConnectionError)
    expect(() => normaliseLidarrBaseUrl('http://lidarr.local?apikey=x')).toThrow(LidarrConnectionError)
    expect(() => normaliseLidarrBaseUrl('ftp://lidarr.local')).toThrow(LidarrConnectionError)
    expect(() => normaliseLidarrBaseUrl('not a url')).toThrow(LidarrConnectionError)
  })
})

describe('LidarrClient error mapping', () => {
  it('maps 401 responses to an UNAUTHENTICATED error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    )
    const client = new LidarrClient('http://lidarr.local', 'api-key-value')
    await expect(client.systemStatus()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('maps network failures to an UNREACHABLE error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const client = new LidarrClient('http://lidarr.local', 'api-key-value')
    await expect(client.systemStatus()).rejects.toMatchObject({ code: 'UNREACHABLE' })
  })

  it('normalises a valid system status payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ version: '2.5.3.4341', instanceName: 'Lidarr' })),
    )
    const client = new LidarrClient('http://lidarr.local', 'api-key-value')
    await expect(client.systemStatus()).resolves.toEqual({ version: '2.5.3.4341', instanceName: 'Lidarr' })
  })
})


describe('LidarrClient bounded responses', () => {
  const client = () => new LidarrClient('http://lidarr.local', 'test-secret')
  const limit = 16 * 1024 * 1024

  it('rejects declared overflow without consuming the body', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.close() } }), {
      headers: { 'content-length': String(limit + 1) },
    })
    const cancel = vi.spyOn(response.body!, 'cancel')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(client().systemStatus()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([undefined, '0', '2'])('caps streamed bytes even with declared length %s', async (length) => {
    const cancel = vi.fn()
    let chunks = 0
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (chunks >= 18) { controller.close(); return }
        chunks++
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32))
      },
      cancel,
    }), { headers: length === undefined ? {} : { 'content-length': length } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(client().systemStatus()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(chunks).toBeLessThanOrEqual(18)
  })
  it('accepts exactly the limit and decodes split UTF-8 correctly', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({'MediaContainer': {}, 'instanceName': 'Björk', 'version': '1'}))
    const split = payload.indexOf(195) + 1
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(payload.slice(0, split))
        controller.enqueue(payload.slice(split))
        controller.enqueue(new Uint8Array(limit - payload.length).fill(32))
        controller.close()
      },
    }))))
    const result = await client().systemStatus()
    expect(result).toBeDefined()
    expect(result).toMatchObject({ instanceName: "Björk" })
  })

})


it('does not forward lidarr credentials to a redirect target (#75)', async () => {
  let targetRequests = 0
  const target = createServer((_request, response) => { targetRequests++; response.setHeader('content-type', 'application/json'); response.end('{}') })
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
  const targetPort = (target.address() as { port: number }).port
  const source = createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/target` }); response.end() })
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
  const sourcePort = (source.address() as { port: number }).port
  try {
    await new LidarrClient(`http://127.0.0.1:${sourcePort}`, 'fixture-secret').systemStatus().catch(() => {})
    expect(targetRequests).toBe(0)
  } finally {
    source.closeAllConnections(); target.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))])
  }
})

it('reads later Lidarr queue pages instead of hiding downloads after item 200', async () => {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    seen.push(input);
    const page = Number(new URL(input).searchParams.get('page') ?? '1');
    const count = page === 1 ? 200 : 1;
    return Response.json({ totalRecords: 201, records: Array.from({ length: count }, (_, i) => ({ id: (page - 1) * 200 + i + 1, artistId: 1, albumId: 2, status: 'downloading' })) });
  }));
  const records = await new LidarrClient('http://lidarr.local', 'test-key').getQueue();
  expect(records).toHaveLength(201);
  expect(records.at(-1)?.id).toBe(201);
  expect(seen).toHaveLength(2);
});

it('fails explicitly instead of returning a partial queue after the paging cap', async () => {
  const fetcher = vi.fn(async () => Response.json({ totalRecords: 10001, records: Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })) }));
  vi.stubGlobal('fetch', fetcher);
  await expect(new LidarrClient('http://lidarr.local', 'test-key').getQueue()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(fetcher).toHaveBeenCalledTimes(50);
});
it('keeps the legacy array queue response and stops at an empty page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 1, status: 'queued' }])));
  expect(await new LidarrClient('http://lidarr.local', 'test-key').getQueue()).toHaveLength(1);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ records: [], totalRecords: 100 })));
  expect(await new LidarrClient('http://lidarr.local', 'test-key').getQueue()).toEqual([]);
});
