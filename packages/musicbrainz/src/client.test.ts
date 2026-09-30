import { describe, expect, it, vi } from "vitest";
import { MusicBrainzClient, MusicBrainzError } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MusicBrainzClient", () => {
  it("sends a contact-bearing User-Agent", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seenInit = init;
      return jsonResponse({ recordings: [] });
    }) as unknown as typeof fetch;
    const client = new MusicBrainzClient({
      contact: "ops@example.com",
      appVersion: "9.9.9",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    await client.searchRecording("Slowdive", "Alison");

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Musearr/9.9.9 ( ops@example.com )");
  });

  it("returns the highest-scoring recording id, or null when there are none", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          recordings: [
            { id: "low", score: 40 },
            { id: "high", score: 98 },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ recordings: [] }));
    const client = new MusicBrainzClient({
      contact: "ops@example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minRequestIntervalMs: 0,
    });

    await expect(client.searchRecording("A", "B")).resolves.toBe("high");
    await expect(client.searchRecording("A", "B")).resolves.toBeNull();
  });

  it("maps 503 to RATE_LIMITED and network failure to UNREACHABLE", async () => {
    const rateLimited = new MusicBrainzClient({
      contact: "ops@example.com",
      minRequestIntervalMs: 0,
      fetchImpl: (async () =>
        new Response("slow down", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(rateLimited.searchRecording("A", "B")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    const offline = new MusicBrainzClient({
      contact: "ops@example.com",
      minRequestIntervalMs: 0,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(offline.searchRecording("A", "B")).rejects.toBeInstanceOf(
      MusicBrainzError,
    );
  });

  it("spaces consecutive requests by the configured interval", async () => {
    const callTimes: number[] = [];
    const fetchImpl = vi.fn(async () => {
      callTimes.push(Date.now());
      return jsonResponse({ recordings: [] });
    });
    const client = new MusicBrainzClient({
      contact: "ops@example.com",
      minRequestIntervalMs: 40,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([
      client.searchRecording("A", "B"),
      client.searchRecording("C", "D"),
    ]);
    expect(callTimes).toHaveLength(2);
    expect(
      (callTimes[1] as number) - (callTimes[0] as number),
    ).toBeGreaterThanOrEqual(35);
  });

  it("normalises a similar-recordings payload and drops the seed itself", async () => {
    const client = new MusicBrainzClient({
      contact: "ops@example.com",
      minRequestIntervalMs: 0,
      fetchImpl: (async () =>
        jsonResponse([
          { recording_mbid: "seed", score: 1 },
          {
            recording_mbid: "n1",
            score: 0.9,
            recording_name: "Vapour Trail",
            artist_credit_name: "Ride",
          },
          { recording_mbid: "n2", score: 0.8 },
        ])) as unknown as typeof fetch,
    });

    const similar = await client.similarRecordings("seed", 10);
    expect(similar.map((row) => row.recordingMbid)).toEqual(["n1", "n2"]);
    expect(similar[0]).toMatchObject({
      recordingName: "Vapour Trail",
      artistName: "Ride",
    });
  });
});

it("#95 caps declared and chunked responses before parsing", async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    let reads = 0;
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        recordings: [{ id: "x".repeat(17 * 1024 * 1024), score: 99 }],
        response: "ok",
        embedding: [1],
      }),
    );
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 1024 * 1024));
        offset += 1024 * 1024;
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(body, {
        headers: declared ? { "content-length": String(17 * 1024 * 1024) } : {},
      })) as typeof fetch;
    const client = new MusicBrainzClient({
      contact: "test@example.com",
      minRequestIntervalMs: 0,
      fetchImpl,
    });
    await expect(client.searchRecording("A", "B")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(18);
  }
});
