import { afterEach, expect, test, vi } from "vitest";
import { LidarrClient } from "./client.js";

afterEach(() => vi.unstubAllGlobals());

test("queue skips malformed row values while retaining valid records", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        records: [
          null,
          7,
          "bad",
          false,
          [],
          { id: 42, title: "Valid", status: "downloading", artistId: 12 },
        ],
        totalRecords: 6,
      }),
    ),
  );
  const client = new LidarrClient("http://localhost:8686", "fixture");
  expect(await client.getQueue()).toEqual([
    {
      id: 42,
      artistId: 12,
      albumId: null,
      status: "downloading",
      trackedDownloadState: null,
      title: "Valid",
    },
  ]);
});

test("queue paging counts all raw rows rather than only accepted rows", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ records: [null, { id: 1 }], totalRecords: 3 }),
    )
    .mockResolvedValueOnce(
      Response.json({ records: [{ id: 2 }], totalRecords: 3 }),
    );
  vi.stubGlobal("fetch", fetchImpl);
  const client = new LidarrClient("http://localhost:8686", "fixture");
  expect((await client.getQueue()).map((row) => row.id)).toEqual([1, 2]);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test("malformed rows at the final total do not cause an extra page request", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ records: [null, { id: 1 }], totalRecords: 2 }),
    );
  vi.stubGlobal("fetch", fetchImpl);
  const client = new LidarrClient("http://localhost:8686", "fixture");
  expect((await client.getQueue()).map((row) => row.id)).toEqual([1]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
