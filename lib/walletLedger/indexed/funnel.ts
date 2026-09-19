import {
  CONDITIONAL_TOKENS_ADDRESS,
  EXCHANGE_ADDRESSES,
  ORDER_FILLED_TOPICS,
} from "@/lib/walletLedger/onchain/contracts";
import {
  decodeLog,
  orderFilledInvolvesWallet,
  topicToAddress,
} from "@/lib/walletLedger/onchain/decode";
import { orderFilledToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";
import type { ParsedOnChainEvent, RpcLog } from "@/lib/walletLedger/onchain/types";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export interface DroppedLogSample {
  contractAddress: string;
  topic0: string;
  topicCount: number;
  decodedEventType: string | null;
  maker: string | null;
  taker: string | null;
  requestedWallet: string;
  reason: string;
}

export interface IndexedEventFunnel {
  rawLogs: number;
  recognizedContract: number;
  recognizedEventSignature: number;
  decodedSuccessfully: number;
  walletMatchedMakerTaker: number;
  normalizedWalletLedgerEvent: number;
  deduplicated: number;
  finalIndexedEvents: number;
  droppedSamples: DroppedLogSample[];
  byParsedType: Record<string, number>;
  rootCause: string;
}

function isRecognizedContract(address: string): boolean {
  const a = address.toLowerCase();
  return (
    EXCHANGE_ADDRESSES.includes(a as (typeof EXCHANGE_ADDRESSES)[number]) ||
    a === CONDITIONAL_TOKENS_ADDRESS
  );
}

function isRecognizedEventSignature(topic0: string | undefined): boolean {
  if (!topic0) return false;
  const t = topic0.toLowerCase();
  return (
    ORDER_FILLED_TOPICS.includes(t as (typeof ORDER_FILLED_TOPICS)[number]) ||
    t === "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c603240f7b5223c0e7f4" ||
    t === "0x72c6024289dce58a3500296fcfb8052f775717b5ccdffdc5978fce8120c9a492" ||
    t === "0x9bcd548aed4c8d09fd6acf72de164de5a4ea5bd8fe04e9e89ced673dc6b9d354" ||
    t === "0x2682012a4a4e07c6edb0e9c08370a417be685dfcdba780e4de5bde6e6494b3ac" ||
    t === "0x4a1384f6d6ea4e2e18596e66fdb9d7e77e5a70d7ed5980a00727e0be9a3bd290"
  );
}

function decodeStageReason(
  parsed: ParsedOnChainEvent,
  wallet: string
): { decoded: boolean; walletMatched: boolean; reason: string } {
  const w = wallet.toLowerCase();
  switch (parsed.type) {
    case "order_filled": {
      const involves = orderFilledInvolvesWallet(parsed.event, w);
      if (!involves) {
        return {
          decoded: true,
          walletMatched: false,
          reason: `order_filled_wallet_mismatch maker=${parsed.event.maker} taker=${parsed.event.taker}`,
        };
      }
      const events = orderFilledToLedgerEvents(parsed.event, w, 1);
      if (events.length === 0) {
        return {
          decoded: true,
          walletMatched: true,
          reason: `order_filled_ledger_rejected asset/shares invalid makerAsset=${parsed.event.makerAssetId} takerAsset=${parsed.event.takerAssetId}`,
        };
      }
      return { decoded: true, walletMatched: true, reason: "ok" };
    }
    case "payout_redemption":
      if (parsed.event.redeemer !== w) {
        return {
          decoded: true,
          walletMatched: false,
          reason: `redeemer_mismatch redeemer=${parsed.event.redeemer}`,
        };
      }
      return { decoded: true, walletMatched: true, reason: "ok" };
    case "position_split":
    case "positions_merge":
      if (parsed.event.stakeholder !== w) {
        return {
          decoded: true,
          walletMatched: false,
          reason: `stakeholder_mismatch stakeholder=${parsed.event.stakeholder}`,
        };
      }
      return { decoded: true, walletMatched: true, reason: "ok" };
    case "erc1155_transfer":
      return {
        decoded: true,
        walletMatched: false,
        reason: "erc1155_transfer_not_mapped_to_ledger_event",
      };
    case "condition_resolution":
      return {
        decoded: true,
        walletMatched: false,
        reason: "condition_resolution_not_wallet_history_event",
      };
    case "unparsed":
      return {
        decoded: false,
        walletMatched: false,
        reason: parsed.reason,
      };
    default:
      return { decoded: false, walletMatched: false, reason: "unknown_parsed_type" };
  }
}

function sampleFromLog(
  log: RpcLog,
  parsed: ParsedOnChainEvent,
  wallet: string,
  reason: string
): DroppedLogSample {
  const maker =
    parsed.type === "order_filled" ? parsed.event.maker : topicToAddress(log.topics[2]);
  const taker =
    parsed.type === "order_filled" ? parsed.event.taker : topicToAddress(log.topics[3]);
  return {
    contractAddress: log.address.toLowerCase(),
    topic0: log.topics[0] ?? "",
    topicCount: log.topics.length,
    decodedEventType: parsed.type === "unparsed" ? null : parsed.type,
    maker,
    taker,
    requestedWallet: wallet.toLowerCase(),
    reason,
  };
}

export function analyzeIndexedEventFunnel(input: {
  logs: RpcLog[];
  parsed: ParsedOnChainEvent[];
  wallet: string;
  blockTimestamps?: Map<number, number>;
  finalEvents?: WalletLedgerEvent[];
}): IndexedEventFunnel {
  const wallet = input.wallet.toLowerCase();
  const blockTimestamps = input.blockTimestamps ?? new Map<number, number>();
  const droppedSamples: DroppedLogSample[] = [];

  let recognizedContract = 0;
  let recognizedEventSignature = 0;
  let decodedSuccessfully = 0;
  let walletMatchedMakerTaker = 0;
  let normalizedWalletLedgerEvent = 0;

  const byParsedType: Record<string, number> = {};

  for (let i = 0; i < input.logs.length; i += 1) {
    const log = input.logs[i];
    const parsed = input.parsed[i] ?? decodeLog(log);
    byParsedType[parsed.type] = (byParsedType[parsed.type] ?? 0) + 1;

    if (isRecognizedContract(log.address)) recognizedContract += 1;
    if (isRecognizedEventSignature(log.topics[0])) recognizedEventSignature += 1;

    const stage = decodeStageReason(parsed, wallet);
    if (parsed.type !== "unparsed") decodedSuccessfully += 1;
    if (stage.walletMatched) walletMatchedMakerTaker += 1;

    if (stage.reason === "ok") {
      if (parsed.type === "order_filled") {
        const blockNumber = parsed.event.blockNumber;
        const ts = blockTimestamps.get(blockNumber) ?? 1;
        normalizedWalletLedgerEvent += orderFilledToLedgerEvents(
          parsed.event,
          wallet,
          ts
        ).length;
      } else {
        normalizedWalletLedgerEvent += 1;
      }
    } else if (droppedSamples.length < 10) {
      droppedSamples.push(sampleFromLog(log, parsed, wallet, stage.reason));
    }
  }

  const ledgerEvents: WalletLedgerEvent[] = [];
  for (const item of input.parsed) {
    const blockNumber =
      item.type === "unparsed"
        ? Number.parseInt(item.raw.blockNumber, 16)
        : item.event.blockNumber;
    const timestamp = blockTimestamps.get(blockNumber) ?? 0;
    if (item.type === "order_filled") {
      ledgerEvents.push(...orderFilledToLedgerEvents(item.event, wallet, timestamp));
    } else if (item.type === "payout_redemption" && item.event.redeemer === wallet) {
      ledgerEvents.push({
        wallet,
        conditionId: item.event.conditionId,
        asset: "",
        timestamp,
        blockNumber: item.event.blockNumber,
        logIndex: item.event.logIndex,
        type: "REDEEM",
        shares: 0,
        cashUsd: Number(item.event.payout) / 1_000_000,
        txHash: item.event.transactionHash,
        source: "polygon",
        dedupeKey: `${item.event.transactionHash}:redeem`,
      });
    } else if (item.type === "position_split" && item.event.stakeholder === wallet) {
      ledgerEvents.push({
        wallet,
        conditionId: item.event.conditionId,
        asset: "",
        timestamp,
        blockNumber: item.event.blockNumber,
        logIndex: item.event.logIndex,
        type: "SPLIT",
        shares: Number(item.event.amount) / 1_000_000,
        cashUsd: 0,
        txHash: item.event.transactionHash,
        source: "polygon",
        dedupeKey: `${item.event.transactionHash}:split`,
      });
    } else if (item.type === "positions_merge" && item.event.stakeholder === wallet) {
      ledgerEvents.push({
        wallet,
        conditionId: item.event.conditionId,
        asset: "",
        timestamp,
        blockNumber: item.event.blockNumber,
        logIndex: item.event.logIndex,
        type: "MERGE",
        shares: Number(item.event.amount) / 1_000_000,
        cashUsd: 0,
        txHash: item.event.transactionHash,
        source: "polygon",
        dedupeKey: `${item.event.transactionHash}:merge`,
      });
    }
  }

  const eventsForFinalCount = input.finalEvents ?? ledgerEvents;
  const dedupe = new Map<string, WalletLedgerEvent>();
  for (const event of eventsForFinalCount) dedupe.set(event.dedupeKey, event);
  const deduplicated = dedupe.size;
  const finalIndexedEvents = deduplicated;

  let rootCause = "none";
  if (input.logs.length > 0 && finalIndexedEvents === 0) {
    const topType = Object.entries(byParsedType).sort((a, b) => b[1] - a[1])[0];
    if (topType?.[0] === "erc1155_transfer") {
      rootCause =
        "F: returned logs are ERC1155 CTF transfers, not OrderFilled trade events";
    } else if (topType?.[0] === "condition_resolution") {
      rootCause = "F: returned logs are ConditionResolution, not wallet trade events";
    } else if (walletMatchedMakerTaker === 0 && decodedSuccessfully > 0) {
      rootCause =
        "E: decoder works but wallet matching rejects logs (subject/wallet mismatch)";
    } else if (decodedSuccessfully > 0 && normalizedWalletLedgerEvent === 0) {
      rootCause =
        "G: decoded trade events rejected during ledger normalization (asset/shares)";
    } else if (recognizedEventSignature < input.logs.length) {
      rootCause = "A: event ABIs/signatures unrecognized for some logs";
    } else {
      rootCause = topType ? `G: dominant parsed type ${topType[0]}` : "G: unknown";
    }
  }

  return {
    rawLogs: input.logs.length,
    recognizedContract,
    recognizedEventSignature,
    decodedSuccessfully,
    walletMatchedMakerTaker,
    normalizedWalletLedgerEvent,
    deduplicated,
    finalIndexedEvents,
    droppedSamples,
    byParsedType,
    rootCause,
  };
}

export function formatFunnelReport(funnel: IndexedEventFunnel): string {
  const lines = [
    "Raw → indexed event funnel",
    `raw logs                       ${funnel.rawLogs}`,
    `recognized contract            ${funnel.recognizedContract}`,
    `recognized event signature     ${funnel.recognizedEventSignature}`,
    `decoded successfully           ${funnel.decodedSuccessfully}`,
    `wallet matched maker/taker     ${funnel.walletMatchedMakerTaker}`,
    `normalized WalletLedgerEvent   ${funnel.normalizedWalletLedgerEvent}`,
    `deduplicated                   ${funnel.deduplicated}`,
    `final indexed events           ${funnel.finalIndexedEvents}`,
    `parsed type counts: ${JSON.stringify(funnel.byParsedType)}`,
    `root cause: ${funnel.rootCause}`,
  ];
  if (funnel.droppedSamples.length > 0) {
    lines.push("", "Dropped log samples:");
    for (const s of funnel.droppedSamples) {
      lines.push(
        `  contract=${s.contractAddress} topic0=${s.topic0} topics=${s.topicCount} type=${s.decodedEventType ?? "null"} maker=${s.maker} taker=${s.taker} wallet=${s.requestedWallet} reason=${s.reason}`
      );
    }
  }
  return lines.join("\n");
}
