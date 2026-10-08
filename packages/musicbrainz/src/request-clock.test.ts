import { expect, test, vi } from "vitest";
import { MusicBrainzClient } from "./client.js";

test("MusicBrainz request spacing is not extended by a backward wall-clock correction", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async () => Response.json({ recordings: [] }));
  const client = new MusicBrainzClient({
    contact: "fixture@example.com",
    minRequestIntervalMs: 1100,
    fetchImpl,
  });
  try {
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    await client.searchRecording("First", "Track");
    vi.setSystemTime(new Date("2026-10-07T11:00:00Z"));
    const next = client.searchRecording("Second", "Track");
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await next;
  } finally {
    vi.useRealTimers();
  }
});

test("MusicBrainz still waits the interval after a forward wall-clock correction", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async () => Response.json({ recordings: [] }));
  const client = new MusicBrainzClient({
    contact: "fixture@example.com",
    minRequestIntervalMs: 1100,
    fetchImpl,
  });
  try {
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    await client.searchRecording("First", "Track");
    vi.setSystemTime(new Date("2026-10-07T13:00:00Z"));
    const next = client.searchRecording("Second", "Track");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1099);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await next;
  } finally {
    vi.useRealTimers();
  }
});
