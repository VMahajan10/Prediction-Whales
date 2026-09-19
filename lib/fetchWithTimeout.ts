import { mergeOutboundHeaders } from "@/lib/outboundHttp";

export const PAGE_FETCH_TIMEOUT_MS = 8000;

export class FetchTimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

export function isFetchTimeoutError(err: unknown): boolean {
  return err instanceof FetchTimeoutError;
}

/** fetch() with per-request timeout on connect/headers; composes with outer AbortSignal. */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const {
    timeoutMs = PAGE_FETCH_TIMEOUT_MS,
    signal: outerSignal,
    ...init
  } = options;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      headers: mergeOutboundHeaders(init.headers),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted && !outerSignal?.aborted) {
      throw new FetchTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

/** fetch() + body read under a single abortable deadline (use for Etherscan/Data API JSON). */
export async function fetchTextWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<{ response: Response; text: string }> {
  const {
    timeoutMs = PAGE_FETCH_TIMEOUT_MS,
    signal: outerSignal,
    ...init
  } = options;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      ...init,
      headers: mergeOutboundHeaders(init.headers),
      signal: controller.signal,
    });
    const text = await response.text();
    if (Date.now() - startedAt > timeoutMs) {
      throw new FetchTimeoutError();
    }
    return { response, text };
  } catch (err) {
    if (controller.signal.aborted && !outerSignal?.aborted) {
      throw new FetchTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}
