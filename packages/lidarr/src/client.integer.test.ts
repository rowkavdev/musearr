import { afterEach, expect, test, vi } from "vitest";
import { LidarrClient } from "./client.js";

afterEach(() => vi.unstubAllGlobals());
const client = () => new LidarrClient("http://localhost:8686", "fixture");

for (const id of [1.9, Number.MAX_SAFE_INTEGER + 1]) {
  test(`artist ID ${id} is rejected instead of aliased to an integer identity`, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          { id, artistName: "Malformed" },
          { id: 7, artistName: "Valid" },
        ]),
      ),
    );
    expect((await client().getArtists()).map((artist) => artist.id)).toEqual([
      7,
    ]);
  });
}

test("addArtist cannot confirm a malformed fractional ID as a different artist", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ id: 1.9, artistName: "Malformed" })),
  );
  await expect(
    client().addArtist({
      foreignArtistId: "fixture",
      artistName: "Name",
      qualityProfileId: 1,
      metadataProfileId: 1,
      rootFolderPath: "/music",
    }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

test("queue foreign IDs retain valid integers but do not round malformed values", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        records: [
          { id: 3, artistId: 1.9, albumId: Number.MAX_SAFE_INTEGER + 1 },
          { id: 4, artistId: 5, albumId: 6 },
        ],
        totalRecords: 2,
      }),
    ),
  );
  expect(
    (await client().getQueue()).map(({ id, artistId, albumId }) => ({
      id,
      artistId,
      albumId,
    })),
  ).toEqual([
    { id: 3, artistId: null, albumId: null },
    { id: 4, artistId: 5, albumId: 6 },
  ]);
});
