import { expect, test } from "vitest";
import { OllamaLocalAiProvider } from "./ollama.js";

test("#100 caps declared and chunked responses before parsing", async () => {
  for (const method of ["complete", "embed"] as const) {
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
          headers: declared
            ? { "content-length": String(17 * 1024 * 1024) }
            : {},
        })) as typeof fetch;
      const provider = new OllamaLocalAiProvider({
        baseUrl: "http://ollama.local",
        model: "fixture",
        fetchImpl,
      });
      await expect(
        method === "complete"
          ? provider.complete({ prompt: "fixture" })
          : provider.embed(["fixture"]),
      ).rejects.toThrow(/16 MiB/);
      expect(cancelled).toBe(true);
      expect(reads).toBeLessThanOrEqual(18);
    }
  }
});

test("accepts small completion and embedding responses", async () => {
  const fetchImpl = (async () =>
    Response.json({ response: "ok", embedding: [1, 2] })) as typeof fetch;
  const provider = new OllamaLocalAiProvider({
    baseUrl: "http://ollama.local",
    model: "fixture",
    fetchImpl,
  });
  await expect(provider.complete({ prompt: "fixture" })).resolves.toBe("ok");
  await expect(provider.embed(["fixture"])).resolves.toEqual([[1, 2]]);
});
