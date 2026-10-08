/**
 * Minimal MusicBrainz + ListenBrainz client used to find tracks similar to a
 * seed, as a deterministic alternative to a local-AI suggestion source.
 *
 * Flow: resolve the seed to a MusicBrainz recording MBID, ask the ListenBrainz
 * "similar-recordings" dataset for neighbours, then fill in any missing
 * title/artist metadata from MusicBrainz.
 *
 * MusicBrainz requires a descriptive User-Agent with contact information and
 * limits anonymous callers to about one request per second per IP, so every
 * outbound request is serialised and spaced.
 */

const DEFAULT_MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const DEFAULT_LISTENBRAINZ_BASE_URL = "https://labs.api.listenbrainz.org";
const DEFAULT_ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30";
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_100;
const REQUEST_TIMEOUT_MS = 12_000;

export class MusicBrainzError extends Error {
  public readonly code: "UNREACHABLE" | "RATE_LIMITED" | "INVALID_RESPONSE";

  constructor(code: MusicBrainzError["code"], message: string) {
    super(message);
    this.name = "MusicBrainzError";
    this.code = code;
  }
}

export type MusicBrainzClientOptions = {
  /** Email address or URL MusicBrainz can use to reach the operator. Required. */
  contact: string;
  appName?: string;
  appVersion?: string;
  musicBrainzBaseUrl?: string;
  listenBrainzBaseUrl?: string;
  algorithm?: string;
  minRequestIntervalMs?: number;
  fetchImpl?: typeof fetch;
};

export type SimilarRecording = {
  recordingMbid: string;
  score: number;
  recordingName: string | null;
  artistName: string | null;
  releaseName: string | null;
};

export type RecordingMetadata = {
  title: string;
  artistName: string;
  releaseName: string | null;
};

type UnknownRecord = Record<string, unknown>;

export class MusicBrainzClient {
  private readonly userAgent: string;
  private readonly musicBrainzBaseUrl: string;
  private readonly listenBrainzBaseUrl: string;
  private readonly algorithm: string;
  private readonly minRequestIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = -Infinity;

  constructor(options: MusicBrainzClientOptions) {
    const appName = options.appName ?? "Musearr";
    const appVersion = options.appVersion ?? "0.1.0";
    this.userAgent = `${appName}/${appVersion} ( ${options.contact.trim()} )`;
    this.musicBrainzBaseUrl = (
      options.musicBrainzBaseUrl ?? DEFAULT_MUSICBRAINZ_BASE_URL
    ).replace(/\/+$/, "");
    this.listenBrainzBaseUrl = (
      options.listenBrainzBaseUrl ?? DEFAULT_LISTENBRAINZ_BASE_URL
    ).replace(/\/+$/, "");
    this.algorithm = options.algorithm ?? DEFAULT_ALGORITHM;
    this.minRequestIntervalMs =
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Best-effort resolve of "artist + title" to a MusicBrainz recording MBID. */
  async searchRecording(
    artistName: string,
    trackTitle: string,
  ): Promise<string | null> {
    const query = `recording:${lucenePhrase(trackTitle)} AND artist:${lucenePhrase(artistName)}`;
    const payload = await this.request<UnknownRecord>(
      `${this.musicBrainzBaseUrl}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`,
    );
    const recordings = Array.isArray(payload.recordings)
      ? (payload.recordings as UnknownRecord[])
      : [];
    let best: { id: string; score: number } | null = null;
    for (const recording of recordings) {
      const id = optionalString(recording.id);
      if (!id) {
        continue;
      }
      const score = typeof recording.score === "number" ? recording.score : 0;
      if (!best || score > best.score) {
        best = { id, score };
      }
    }
    return best?.id ?? null;
  }

  async similarRecordings(
    recordingMbid: string,
    limit: number,
  ): Promise<SimilarRecording[]> {
    const url =
      `${this.listenBrainzBaseUrl}/similar-recordings/json` +
      `?recording_mbids=${encodeURIComponent(recordingMbid)}` +
      `&algorithm=${encodeURIComponent(this.algorithm)}`;
    const payload = await this.request<unknown>(url);
    const rows = Array.isArray(payload)
      ? (payload as UnknownRecord[])
      : Array.isArray((payload as UnknownRecord)?.recordings)
        ? ((payload as UnknownRecord).recordings as UnknownRecord[])
        : [];

    const seen = new Set<string>([recordingMbid]);
    const similar: SimilarRecording[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") {
        continue;
      }
      const recordingMbidValue =
        optionalString(row.recording_mbid) ?? optionalString(row.mbid);
      if (!recordingMbidValue || seen.has(recordingMbidValue)) {
        continue;
      }
      seen.add(recordingMbidValue);
      similar.push({
        recordingMbid: recordingMbidValue,
        score: typeof row.score === "number" ? row.score : 0,
        recordingName:
          optionalString(row.recording_name) ??
          optionalString(row.recording_title),
        artistName:
          optionalString(row.artist_credit_name) ??
          optionalString(row.artist_name),
        releaseName:
          optionalString(row.release_name) ??
          optionalString(row.caa_release_name),
      });
      if (similar.length >= limit) {
        break;
      }
    }
    return similar;
  }

  async lookupRecording(
    recordingMbid: string,
  ): Promise<RecordingMetadata | null> {
    const payload = await this.request<UnknownRecord>(
      `${this.musicBrainzBaseUrl}/recording/${encodeURIComponent(recordingMbid)}?inc=artist-credits+releases&fmt=json`,
    );
    const title = optionalString(payload.title);
    if (!title) {
      return null;
    }
    const artistCredit = Array.isArray(payload["artist-credit"])
      ? (payload["artist-credit"] as UnknownRecord[])
      : [];
    const artistName = artistCredit
      .map(
        (credit) =>
          `${optionalString(credit.name) ?? ""}${typeof credit.joinphrase === "string" ? credit.joinphrase : ""}`,
      )
      .join("")
      .trim();
    const releases = Array.isArray(payload.releases)
      ? (payload.releases as UnknownRecord[])
      : [];
    return {
      title,
      artistName: artistName || "Unknown Artist",
      releaseName: optionalString(releases[0]?.title),
    };
  }

  private async request<T>(url: string): Promise<T> {
    return this.schedule(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(url, {
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: controller.signal,
        });
        if (response.status === 503 || response.status === 429) {
          throw new MusicBrainzError(
            "RATE_LIMITED",
            "MusicBrainz asked Musearr to slow down.",
          );
        }
        if (!response.ok) {
          throw new MusicBrainzError(
            "UNREACHABLE",
            "Musearr could not reach MusicBrainz.",
          );
        }
        try {
          const parsed: unknown = JSON.parse(await readBoundedResponse(response));
          if (parsed === null || typeof parsed !== "object") {
            throw new Error("not an object");
          }
          return parsed as T;
        } catch {
          throw new MusicBrainzError(
            "INVALID_RESPONSE",
            "MusicBrainz returned an unreadable response.",
          );
        }
      } catch (error) {
        if (error instanceof MusicBrainzError) {
          throw error;
        }
        throw new MusicBrainzError(
          "UNREACHABLE",
          "Musearr could not reach MusicBrainz.",
        );
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait =
        this.minRequestIntervalMs - (performance.now() - this.lastRequestAt);
      if (wait > 0) {
        await delay(wait);
      }
      this.lastRequestAt = performance.now();
      return task();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function lucenePhrase(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new MusicBrainzError(
      "INVALID_RESPONSE",
      "MusicBrainz response exceeds the 16 MiB limit.",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new MusicBrainzError(
          "INVALID_RESPONSE",
          "MusicBrainz response exceeds the 16 MiB limit.",
        );
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}
