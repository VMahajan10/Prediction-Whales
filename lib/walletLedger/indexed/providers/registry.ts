import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import { probeProviderWithRetry } from "@/lib/walletLedger/indexed/providerProbe";
import { BlockscoutLogProvider } from "@/lib/walletLedger/indexed/providers/blockscout";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { FullHistoryRpcProvider } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import type {
  IndexedLogProvider,
  IndexedProviderEvaluation,
  IndexedProviderId,
  IndexedProviderProbeResult,
} from "@/lib/walletLedger/indexed/types";

let cachedProviderEvaluations: IndexedProviderEvaluation[] | null = null;

export function setCachedProviderEvaluations(
  evaluations: IndexedProviderEvaluation[] | null
): void {
  cachedProviderEvaluations = evaluations;
}

export function getCachedProviderEvaluations(): IndexedProviderEvaluation[] | null {
  return cachedProviderEvaluations;
}

export function clearCachedProviderEvaluations(): void {
  cachedProviderEvaluations = null;
}

export interface ProviderSelectionResult {
  provider: IndexedLogProvider;
  probe: IndexedProviderProbeResult;
  probeAttempts: number;
  reusedEvaluation: boolean;
}

export function listIndexedProviders(): IndexedLogProvider[] {
  return [
    new EtherscanV2LogProvider(),
    new BlockscoutLogProvider(),
    new FullHistoryRpcProvider(),
  ];
}

export function resolveIndexedProvider(
  preferred?: IndexedProviderId
): IndexedLogProvider {
  const providers = listIndexedProviders();
  if (preferred) {
    const match = providers.find((p) => p.id === preferred);
    if (match) return match;
  }
  const etherscan = providers.find((p) => p.id === "etherscan_v2");
  if (etherscan) return etherscan;
  return providers.find((p) => p.id === "full_history_rpc")!;
}

function logProviderSelect(input: {
  providerId: IndexedProviderId;
  probeAttempts: number;
  reusedEvaluation: boolean;
  available: boolean;
  reason: string;
}): void {
  const line = [
    "[provider-select]",
    `provider=${input.providerId}`,
    `probeAttempts=${input.probeAttempts}`,
    `reusedEvaluation=${input.reusedEvaluation}`,
    `available=${input.available}`,
    `reason=${input.reason}`,
  ].join(" ");
  console.error(line);
  auditLog(line);
}

function findEvaluation(
  providerId: IndexedProviderId,
  evaluations?: IndexedProviderEvaluation[] | null
): IndexedProviderEvaluation | undefined {
  const source = evaluations ?? cachedProviderEvaluations;
  return source?.find((ev) => ev.providerId === providerId);
}

function selectionFromEvaluation(
  provider: IndexedLogProvider,
  evaluation: IndexedProviderEvaluation
): ProviderSelectionResult {
  const attempts = evaluation.probeAttempts ?? 1;
  logProviderSelect({
    providerId: provider.id,
    probeAttempts: attempts,
    reusedEvaluation: true,
    available: evaluation.probe.available,
    reason: evaluation.probe.error ?? "ok",
  });
  return {
    provider,
    probe: evaluation.probe,
    probeAttempts: attempts,
    reusedEvaluation: true,
  };
}

async function selectionFromProbe(
  provider: IndexedLogProvider
): Promise<ProviderSelectionResult> {
  const { probe, attempts } = await probeProviderWithRetry(provider);
  logProviderSelect({
    providerId: provider.id,
    probeAttempts: attempts,
    reusedEvaluation: false,
    available: probe.available,
    reason: probe.error ?? "ok",
  });
  return {
    provider,
    probe,
    probeAttempts: attempts,
    reusedEvaluation: false,
  };
}

export async function evaluateIndexedProviders(): Promise<
  IndexedProviderEvaluation[]
> {
  const evaluations: IndexedProviderEvaluation[] = [];
  for (const provider of listIndexedProviders()) {
    const { probe, attempts } = await probeProviderWithRetry(provider);
    const evaluation: IndexedProviderEvaluation = {
      providerId: provider.id,
      probe,
      probeAttempts: attempts,
    };
    if (probe.available && provider.id === "full_history_rpc") {
      const started = Date.now();
      const sample = await provider.getLogsPaginated({
        fromBlock: 92_490_000,
        toBlock: 92_495_000,
        address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        topics: [
          "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6",
        ],
      });
      evaluation.sampleFetch = {
        requests: sample.stats.requests,
        elapsedMs: Date.now() - started,
        logsReturned: sample.stats.logsReturned,
        pages: sample.stats.pages,
      };
    }
    evaluations.push(evaluation);
  }
  setCachedProviderEvaluations(evaluations);
  return evaluations;
}

export async function selectBestAvailableProvider(
  preferred?: IndexedProviderId,
  options: { evaluations?: IndexedProviderEvaluation[] } = {}
): Promise<ProviderSelectionResult> {
  const evaluations = options.evaluations ?? cachedProviderEvaluations;

  if (preferred && preferred !== "etherscan_v2") {
    const provider = resolveIndexedProvider(preferred);
    const cached = findEvaluation(preferred, evaluations);
    if (cached) {
      return selectionFromEvaluation(provider, cached);
    }
    return selectionFromProbe(provider);
  }

  const cachedEtherscan = findEvaluation("etherscan_v2", evaluations);
  if (cachedEtherscan?.probe.available) {
    return selectionFromEvaluation(new EtherscanV2LogProvider(), cachedEtherscan);
  }

  const etherscan = new EtherscanV2LogProvider();
  const { probe, attempts } = await probeProviderWithRetry(etherscan);
  if (probe.available) {
    logProviderSelect({
      providerId: etherscan.id,
      probeAttempts: attempts,
      reusedEvaluation: false,
      available: true,
      reason: "ok",
    });
    return {
      provider: etherscan,
      probe,
      probeAttempts: attempts,
      reusedEvaluation: false,
    };
  }

  if (preferred === "etherscan_v2") {
    const reason = probe.error?.trim() || "unknown";
    logProviderSelect({
      providerId: "etherscan_v2",
      probeAttempts: attempts,
      reusedEvaluation: false,
      available: false,
      reason,
    });
    throw new Error(
      `Etherscan V2 unavailable; refusing full_history_rpc fallback (${reason})`
    );
  }

  const rpcProvider = new FullHistoryRpcProvider();
  const cachedRpc = findEvaluation("full_history_rpc", evaluations);
  if (cachedRpc) {
    return selectionFromEvaluation(rpcProvider, cachedRpc);
  }
  return selectionFromProbe(rpcProvider);
}
