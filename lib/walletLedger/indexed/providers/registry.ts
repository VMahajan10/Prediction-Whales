import { BlockscoutLogProvider } from "@/lib/walletLedger/indexed/providers/blockscout";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { FullHistoryRpcProvider } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import type {
  IndexedLogProvider,
  IndexedProviderEvaluation,
  IndexedProviderId,
} from "@/lib/walletLedger/indexed/types";

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

export async function evaluateIndexedProviders(): Promise<
  IndexedProviderEvaluation[]
> {
  const evaluations: IndexedProviderEvaluation[] = [];
  for (const provider of listIndexedProviders()) {
    const probe = await provider.probe();
    const evaluation: IndexedProviderEvaluation = { providerId: provider.id, probe };
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
  return evaluations;
}

export async function selectBestAvailableProvider(
  preferred?: IndexedProviderId
): Promise<IndexedLogProvider> {
  if (preferred && preferred !== "etherscan_v2") {
    return resolveIndexedProvider(preferred);
  }
  const etherscan = new EtherscanV2LogProvider();
  const probe = await etherscan.probe();
  if (probe.available) return etherscan;
  return new FullHistoryRpcProvider();
}
