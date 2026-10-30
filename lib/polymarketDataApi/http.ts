import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";

export const DATA_API_BASE = "https://data-api.polymarket.com";

const DEFAULT_SPACING_MS = 120;
const MAX_RETRIES = 4;

let lastRequestAt = 0;

async function pace(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + DEFAULT_SPACING_MS - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

export async function dataApiGetJson<T>(
  path: string,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const params = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") params.set(k, String(v));
    }
  }
  const qs = params.toString();
  const url = `${DATA_API_BASE}${path}${qs ? `?${qs}` : ""}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await pace();
    try {
      const res = await fetchWithTimeout(url, {
        headers: mergeOutboundHeaders({ Accept: "application/json" }),
      });
      if (res.status === 429 || res.status >= 500) {
        const backoff = 250 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Data API ${res.status} ${path}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const backoff = 250 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
