/**
 * Node/worker HTTP client for POST /api/ev/trades with extended Undici timeouts.
 * Browser code should use pipelineEvClient (AbortSignal) instead.
 */
import { resolveAppApiUrl } from "@/lib/appBaseUrl";

export const PIPELINE_EV_HTTP_TIMEOUT_MS = 60_000;

type UndiciModule = {
  Agent: new (options?: {
    headersTimeout?: number;
    bodyTimeout?: number;
    connectTimeout?: number;
  }) => unknown;
  fetch: typeof fetch;
};

let evHttpAgent: unknown | null = null;

async function loadUndici(): Promise<UndiciModule | null> {
  try {
    return (await import("undici")) as UndiciModule;
  } catch {
    return null;
  }
}

async function getEvHttpAgent(): Promise<unknown | undefined> {
  if (evHttpAgent) return evHttpAgent;
  const undici = await loadUndici();
  if (!undici) return undefined;
  evHttpAgent = new undici.Agent({
    headersTimeout: PIPELINE_EV_HTTP_TIMEOUT_MS,
    bodyTimeout: PIPELINE_EV_HTTP_TIMEOUT_MS,
    connectTimeout: 30_000,
  });
  return evHttpAgent;
}

export async function postPipelineEvTrades(
  items: unknown[],
  options?: { timeoutMs?: number }
): Promise<Response> {
  const url = resolveAppApiUrl("/api/ev/trades");
  const timeoutMs = options?.timeoutMs ?? PIPELINE_EV_HTTP_TIMEOUT_MS;
  const undici = await loadUndici();
  const dispatcher = await getEvHttpAgent();

  const init: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (undici && dispatcher) {
    init.dispatcher = dispatcher;
    return undici.fetch(url, init as RequestInit);
  }

  return fetch(url, init);
}

export async function getPipelineEvTrade(
  params: URLSearchParams,
  options?: { timeoutMs?: number }
): Promise<Response> {
  const url = resolveAppApiUrl(`/api/ev/trades?${params.toString()}`);
  const timeoutMs = options?.timeoutMs ?? PIPELINE_EV_HTTP_TIMEOUT_MS;
  const undici = await loadUndici();
  const dispatcher = await getEvHttpAgent();

  const init: RequestInit & { dispatcher?: unknown } = {
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (undici && dispatcher) {
    init.dispatcher = dispatcher;
    return undici.fetch(url, init as RequestInit);
  }

  return fetch(url, init);
}
