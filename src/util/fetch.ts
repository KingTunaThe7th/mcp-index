/**
 * HTTP helpers with bounded retries.
 *
 * Only used for read-only fetches against the MCP registry and a small number
 * of hard-coded hosts. Callers pass an explicit timeout so a hung upstream can
 * never wedge a sync.
 */

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Accept 4xx without throwing (returns the response). */
  allowHttpErrors?: boolean;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base + Math.floor(Math.random() * 250);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function request(url: string, options: FetchOptions): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = options.retries ?? 3;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal =
      signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      const response = await fetch(url, {
        signal,
        redirect: "follow",
        headers: {
          accept: "application/json",
          "user-agent": "mcp-index (+https://github.com/KingTunaThe7th/mcp-index)",
          ...options.headers,
        },
      });

      if (RETRYABLE.has(response.status) && attempt < retries) {
        await sleep(backoffMs(attempt, response.headers.get("retry-after")));
        continue;
      }

      if (!response.ok && !options.allowHttpErrors) {
        const body = await response.text().catch(() => "");
        throw new HttpError(url, response.status, body);
      }

      return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (attempt >= retries) break;
      await sleep(backoffMs(attempt, null));
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`request failed after ${retries + 1} attempts: ${url}: ${reason}`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await request(url, {
    ...options,
    headers: { accept: "application/json", ...options.headers },
  });
  return (await response.json()) as T;
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await request(url, {
    ...options,
    headers: { accept: "text/plain,*/*", ...options.headers },
  });
  return await response.text();
}
