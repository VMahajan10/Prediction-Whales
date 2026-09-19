import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import type { IndexedLogQuery } from "@/lib/walletLedger/indexed/types";
import {
  CONDITIONAL_TOKENS_ADDRESS,
  CTF_EXCHANGE_LEGACY_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  CTF_EXCHANGE_V2_ADDRESS,
  EXCHANGE_ADDRESSES,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  ORDER_FILLED_TOPICS,
  TOPIC_ORDER_FILLED_NEG_RISK,
  TOPIC_ORDER_FILLED_V1,
  TOPIC_PAYOUT_REDEMPTION,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
} from "@/lib/walletLedger/onchain/contracts";
import { walletTopic } from "@/lib/walletLedger/onchain/rpc";

export const ETHERSCAN_MAX_BLOCK_RANGE = 4_999;

export interface WalletLogQueryDescriptor {
  index: number;
  contract: string;
  contractLabel: string;
  eventKind: string;
  walletRole: string;
  topic0: string | string[] | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  fromBlock: number;
  toBlock: number;
}

export interface EtherscanQueryPlanReport {
  wallet: string;
  fromBlock: number;
  toBlock: number;
  blockSpan: number;
  blockWindowsPerQuery: number;
  walletLogQueries: number;
  contractsQueried: string[];
  eventSignaturesQueried: string[];
  walletRoleQueries: string[];
  estimatedRequestsMin: number;
  estimatedPagesMin: number;
  multiplication: string;
  queries: WalletLogQueryDescriptor[];
}

const CONTRACT_LABELS: Record<string, string> = {
  [CTF_EXCHANGE_LEGACY_ADDRESS]: "CTF Exchange legacy",
  [CTF_EXCHANGE_V1_ADDRESS]: "CTF Exchange v1",
  [NEG_RISK_CTF_EXCHANGE_ADDRESS]: "Neg Risk CTF Exchange",
  [CTF_EXCHANGE_V2_ADDRESS]: "CTF Exchange v2",
  [CONDITIONAL_TOKENS_ADDRESS]: "ConditionalTokens",
};

export const ORDER_FILLED_EVENT_SIGNATURES = {
  v1: "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
  negRisk:
    "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
} as const;

export const ORDER_FILLED_TOPIC_LAYOUT = [
  {
    exchange: CTF_EXCHANGE_LEGACY_ADDRESS,
    label: "CTF Exchange legacy",
    topic0: TOPIC_ORDER_FILLED_V1,
    topic1: "orderHash (indexed)",
    topic2: "maker (indexed)",
    topic3: "taker (indexed)",
  },
  {
    exchange: CTF_EXCHANGE_V1_ADDRESS,
    label: "CTF Exchange v1",
    topic0: TOPIC_ORDER_FILLED_V1,
    topic1: "orderHash (indexed)",
    topic2: "maker (indexed)",
    topic3: "taker (indexed)",
  },
  {
    exchange: NEG_RISK_CTF_EXCHANGE_ADDRESS,
    label: "Neg Risk CTF Exchange",
    topic0: TOPIC_ORDER_FILLED_NEG_RISK,
    topic1: "orderHash (indexed)",
    topic2: "maker (indexed)",
    topic3: "taker (indexed)",
  },
  {
    exchange: CTF_EXCHANGE_V2_ADDRESS,
    label: "CTF Exchange v2",
    topic0: TOPIC_ORDER_FILLED_NEG_RISK,
    topic1: "orderHash (indexed)",
    topic2: "maker (indexed)",
    topic3: "taker (indexed)",
  },
] as const;

function blockWindowsForRange(
  fromBlock: number,
  toBlock: number,
  windowSize = ETHERSCAN_MAX_BLOCK_RANGE
): number {
  if (toBlock < fromBlock) return 0;
  let count = 0;
  for (let from = fromBlock; from <= toBlock; from += windowSize + 1) {
    count += 1;
  }
  return count;
}

function describeQuery(
  query: Omit<IndexedLogQuery, "page" | "offset">,
  index: number
): WalletLogQueryDescriptor {
  const contract = query.address.toLowerCase();
  const topics = query.topics ?? [];
  const topic0 = topics[0] ?? null;
  const topic1 = typeof topics[1] === "string" ? topics[1] : null;
  const topic2 = typeof topics[2] === "string" ? topics[2] : null;
  const topic3 = typeof topics[3] === "string" ? topics[3] : null;

  let eventKind = "unknown";
  let walletRole = "unknown";
  if (
    EXCHANGE_ADDRESSES.includes(contract as (typeof EXCHANGE_ADDRESSES)[number])
  ) {
    eventKind = "OrderFilled";
    walletRole = topic2 && !topic3 ? "maker" : topic3 ? "taker" : "unknown";
  } else if (contract === CONDITIONAL_TOKENS_ADDRESS) {
    if (topic0 === TOPIC_POSITION_SPLIT) {
      eventKind = "PositionSplit";
      walletRole = "stakeholder";
    } else if (topic0 === TOPIC_POSITIONS_MERGE) {
      eventKind = "PositionsMerge";
      walletRole = "stakeholder";
    } else if (topic0 === TOPIC_PAYOUT_REDEMPTION) {
      eventKind = "PayoutRedemption";
      walletRole = "redeemer";
    }
  }

  return {
    index,
    contract,
    contractLabel: CONTRACT_LABELS[contract] ?? contract,
    eventKind,
    walletRole,
    topic0,
    topic1,
    topic2,
    topic3,
    fromBlock: query.fromBlock,
    toBlock: query.toBlock,
  };
}

export function buildEtherscanQueryPlan(
  wallet: string,
  fromBlock: number,
  toBlock: number,
  scanSubjects: string[] = [wallet]
): EtherscanQueryPlanReport {
  const queries = buildWalletLogQueries(wallet, fromBlock, toBlock);
  const blockSpan = Math.max(0, toBlock - fromBlock + 1);
  const walletLogQueries = queries.length;
  const subjectCount = scanSubjects.length;
  const orderFilledQueries = queries.filter((q) =>
    EXCHANGE_ADDRESSES.includes(
      q.address.toLowerCase() as (typeof EXCHANGE_ADDRESSES)[number]
    )
  ).length;
  const ctfQueries = walletLogQueries - orderFilledQueries;
  const exchangeCount = EXCHANGE_ADDRESSES.length;
  const estimatedRequestsMin = walletLogQueries * subjectCount;
  const descriptors = queries.map((q, i) => describeQuery(q, i));

  const contractsQueried = [...new Set(descriptors.map((d) => d.contract))];
  const eventSignaturesQueried = [
    ...ORDER_FILLED_TOPICS,
    TOPIC_POSITION_SPLIT,
    TOPIC_POSITIONS_MERGE,
    TOPIC_PAYOUT_REDEMPTION,
  ];
  const walletRoleQueries = descriptors.map(
    (d) => `${d.contractLabel}:${d.eventKind}:${d.walletRole}`
  );

  return {
    wallet: wallet.toLowerCase(),
    fromBlock,
    toBlock,
    blockSpan,
    blockWindowsPerQuery: 1,
    walletLogQueries,
    contractsQueried,
    eventSignaturesQueried,
    walletRoleQueries,
    estimatedRequestsMin,
    estimatedPagesMin: estimatedRequestsMin,
    multiplication: [
      `${subjectCount} subject(s)`,
      `× ${orderFilledQueries} OrderFilled queries (${exchangeCount} exchanges × maker/taker)`,
      `× ${ctfQueries} Split/Merge/Redeem queries`,
      `× 1 broad indexed range each (adaptive split only on pagination/result limits)`,
      `= ${estimatedRequestsMin} requests minimum`,
      `(legacy fixed 5k windows would be ~${blockWindowsForRange(fromBlock, toBlock) * walletLogQueries * subjectCount})`,
    ].join(" "),
    queries: descriptors,
  };
}

export function formatWalletTopicEncoding(wallet: string): string {
  return walletTopic(wallet);
}
