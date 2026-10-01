import { describe, expect, it } from "vitest";
import { MusicBrainzClient } from "./client.js";

const make = (body: string) =>
  new MusicBrainzClient({
    contact: "a@b.c",
    minRequestIntervalMs: 0,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

describe("null JSON bodies", () => {
  it("searchRecording and lookupRecording report INVALID_RESPONSE", async () => {
    for (const call of [
      () => make("null").searchRecording("a", "b"),
      () => make("null").lookupRecording("x"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
  it("similarRecordings skips null rows", async () => {
    expect(await make("[null]").similarRecordings("x", 5)).toEqual([]);
  });
});
