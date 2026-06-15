import { resolveWalletByTradeHash } from "@/lib/polymarket";

const POLYGON_RPC_URLS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
];

const ORDER_FILLED_TOPIC_PREFIX = "0xd543adfd";

/** Contracts that are never the user's proxyWallet. */
const SYSTEM_ADDRESSES = new Set([
  "0xe2222d279d744050d28e00520010520000310f59",
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
  "0xe111180000d2663c0091e4f400237545b87b996b",
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
  "0x2791bca1f2de4661ed88a30c99d7a81a19cb3c11",
  "0xd95518d7300450c286f6985bc271e52ebe6f0000",
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000001010",
]);

export type WalletResolveSource =
  | "onchain"
  | "data-api-asset"
  | "data-api-global"
  | null;

interface TxLog {
  address: string;
  topics: string[];
  data: string;
}

function topicToAddress(topic: string): string | null {
  if (!topic || topic.length !== 66) return null;
  return ("0x" + topic.slice(26)).toLowerCase();
}

function isUserAddress(addr: string): boolean {
  return (
    !SYSTEM_ADDRESSES.has(addr) &&
    addr !== "0x0000000000000000000000000000000000000000"
  );
}

async function fetchTransactionReceipt(
  hash: string
): Promise<{ logs: TxLog[] } | null> {
  for (const rpc of POLYGON_RPC_URLS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [hash],
        }),
        next: { revalidate: 0 },
      });
      const json = (await res.json()) as {
        result?: { logs?: TxLog[] };
      };
      if (json.result?.logs) {
        return { logs: json.result.logs };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function collectWalletCandidates(
  logs: TxLog[],
  assetHex: string | null
): Map<string, number> {
  const counts = new Map<string, number>();

  const considerLog = (log: TxLog, requireAsset: boolean) => {
    const data = log.data?.slice(2) ?? "";
    const refsAsset = assetHex ? data.includes(assetHex) : true;
    if (requireAsset && assetHex && !refsAsset) return;

    const isOrderFilled = log.topics[0]?.startsWith(ORDER_FILLED_TOPIC_PREFIX);
    if (!requireAsset && !isOrderFilled && !refsAsset) return;

    for (let i = 1; i < log.topics.length; i++) {
      const addr = topicToAddress(log.topics[i]);
      if (!addr || !isUserAddress(addr)) continue;
      counts.set(addr, (counts.get(addr) ?? 0) + 1);
    }
  };

  for (const log of logs) {
    considerLog(log, !!assetHex);
  }

  if (counts.size === 0 && assetHex) {
    for (const log of logs) {
      considerLog(log, true);
    }
  }

  return counts;
}

function pickBestWallet(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [addr, count] of Array.from(counts.entries())) {
    if (count > bestCount) {
      best = addr;
      bestCount = count;
    }
  }
  return best;
}

/** Extract proxyWallet from Polygon OrderFilled receipt logs (~100-200ms). */
export async function resolveWalletOnChain(
  hash: string,
  assetId?: string
): Promise<string | null> {
  const receipt = await fetchTransactionReceipt(hash);
  if (!receipt?.logs?.length) return null;

  const assetHex = assetId
    ? BigInt(assetId).toString(16).padStart(64, "0")
    : null;

  const counts = collectWalletCandidates(receipt.logs, assetHex);
  return pickBestWallet(counts);
}

/** On-chain first, then per-asset Data API, then global Data API scan. */
export async function resolveWalletForTrade(
  hash: string,
  options?: { assetId?: string }
): Promise<{ wallet: string | null; source: WalletResolveSource }> {
  const onchain = await resolveWalletOnChain(hash, options?.assetId);
  if (onchain) {
    return { wallet: onchain, source: "onchain" };
  }

  const fromApi = await resolveWalletByTradeHash(hash, options?.assetId);
  if (fromApi) {
    return {
      wallet: fromApi,
      source: options?.assetId ? "data-api-asset" : "data-api-global",
    };
  }

  return { wallet: null, source: null };
}
