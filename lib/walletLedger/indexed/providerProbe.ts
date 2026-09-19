import type {
  IndexedLogProvider,
  IndexedProviderProbeResult,
} from "@/lib/walletLedger/indexed/types";

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;

export type ProbeFailureKind = "transient" | "permanent" | "unknown";

export function classifyProbeFailure(
  error: string | null,
  notes: string[] = []
): ProbeFailureKind {
  if (!error) return "unknown";
  const e = error.toLowerCase();

  if (e === "missing_api_key") return "permanent";
  if (/invalid api key|api key invalid|invalid key/i.test(e)) return "permanent";
  if (/unsupported chain|invalid chain|malformed/i.test(e)) return "permanent";
  if (/http_401|http_403/.test(e)) return "permanent";

  if (/etimedout|econnreset|econnrefused|timeout|timed out/i.test(e)) {
    return "transient";
  }
  if (/network|fetch failed|abort/i.test(e)) return "transient";
  if (/rate|limit|429/.test(e)) return "transient";
  if (/http_5\d{2}/.test(e)) return "transient";
  if (notes.includes("probe_network_error")) return "transient";

  return "unknown";
}

export function isTransientProbeFailure(
  error: string | null,
  notes: string[] = []
): boolean {
  return classifyProbeFailure(error, notes) === "transient";
}

export function isPermanentProbeFailure(
  error: string | null,
  notes: string[] = []
): boolean {
  return classifyProbeFailure(error, notes) === "permanent";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 100);
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) + jitter;
}

export async function probeProviderWithRetry(
  provider: IndexedLogProvider,
  options: { maxAttempts?: number } = {}
): Promise<{ probe: IndexedProviderProbeResult; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastProbe: IndexedProviderProbeResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastProbe = await provider.probe();
    if (lastProbe.available) {
      return { probe: lastProbe, attempts: attempt };
    }

    if (isPermanentProbeFailure(lastProbe.error, lastProbe.notes)) {
      return { probe: lastProbe, attempts: attempt };
    }

    const shouldRetry =
      attempt < maxAttempts &&
      isTransientProbeFailure(lastProbe.error, lastProbe.notes);
    if (!shouldRetry) {
      return { probe: lastProbe, attempts: attempt };
    }

    await sleep(backoffDelayMs(attempt));
  }

  return { probe: lastProbe!, attempts: maxAttempts };
}
