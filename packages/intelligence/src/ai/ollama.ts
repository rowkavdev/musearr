import {
  LocalAiUnavailableError,
  type LocalAiCompletionRequest,
  type LocalAiProvider,
} from "./provider.js";

const REQUEST_TIMEOUT_MS = 60_000;

export type OllamaProviderOptions = {
  baseUrl: string;
  model: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

/**
 * Experimental adapter for a locally running Ollama server
 * (https://ollama.com). It is only constructed when the owner explicitly
 * enables local AI; it is never the default. All requests go to the
 * owner-provided `baseUrl` on their own network.
 */
export class OllamaLocalAiProvider implements LocalAiProvider {
  readonly name = "ollama" as const;
  readonly enabled = true;
  readonly model: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async isReachable(): Promise<boolean> {
    try {
      const response = await this.request("/api/tags", undefined, 5_000);
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(request: LocalAiCompletionRequest): Promise<string> {
    const response = await this.request("/api/generate", {
      model: this.model,
      prompt: request.prompt,
      ...(request.system === undefined ? {} : { system: request.system }),
      stream: false,
      options: {
        temperature: request.temperature ?? 0.2,
        ...(request.maxTokens === undefined
          ? {}
          : { num_predict: request.maxTokens }),
      },
    });
    if (!response.ok) {
      throw new LocalAiUnavailableError(
        `Ollama returned HTTP ${response.status}.`,
      );
    }
    const payload = JSON.parse(await readBoundedResponse(response)) as {
      response?: unknown;
    };
    return typeof payload.response === "string" ? payload.response : "";
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      const response = await this.request("/api/embeddings", {
        model: this.model,
        prompt: text,
      });
      if (!response.ok) {
        throw new LocalAiUnavailableError(
          `Ollama returned HTTP ${response.status}.`,
        );
      }
      const payload = JSON.parse(await readBoundedResponse(response)) as {
        embedding?: unknown;
      };
      vectors.push(
        Array.isArray(payload.embedding) ? (payload.embedding as number[]) : [],
      );
    }
    return vectors;
  }

  private async request(
    path: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new LocalAiUnavailableError(
      "Ollama response exceeds the 16 MiB limit.",
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
        throw new LocalAiUnavailableError(
          "Ollama response exceeds the 16 MiB limit.",
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
