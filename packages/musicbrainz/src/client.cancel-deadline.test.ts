import { expect, test, vi } from "vitest";
import { MusicBrainzClient } from "./client.js";

const limit = 16 * 1024 * 1024;

for (const mode of ["declared", "streamed"]) {
  test(`MusicBrainz rejects ${mode} oversize without waiting on stream cleanup or blocking queued requests`, async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === "streamed")
            controller.enqueue(new Uint8Array(limit + 1));
        },
        cancel,
      }),
      {
        headers:
          mode === "declared" ? { "content-length": String(limit + 1) } : {},
      },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(Response.json({ recordings: [{ id: "good" }] }));
    const client = new MusicBrainzClient({
      contact: "fixture@example.com",
      minRequestIntervalMs: 0,
      fetchImpl,
    });
    const first = client
      .searchRecording("First", "Track")
      .catch((error: unknown) => error);
    const next = client.searchRecording("Second", "Track");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        Promise.all([first, next]),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("hung"), 100);
        }),
      ]);
      expect(outcome).toEqual([
        expect.objectContaining({ code: "INVALID_RESPONSE" }),
        "good",
      ]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      clearTimeout(timer);
    }
  });
}
