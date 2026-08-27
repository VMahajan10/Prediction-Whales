import { buildLedgerEventDedupeKey } from "@/lib/walletLedger/normalize";
import {
  orderFilledInvolvesWallet,
  tokenAmountToNumber,
} from "@/lib/walletLedger/onchain/decode";
import type {
  ParsedOnChainEvent,
  ParsedOrderFilled,
} from "@/lib/walletLedger/onchain/types";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const USDC_ASSET_ID = "0";

export function orderFilledToLedgerEvents(
  event: ParsedOrderFilled,
  wallet: string,
  timestamp: number
): WalletLedgerEvent[] {
  if (!orderFilledInvolvesWallet(event, wallet)) return [];
  const w = wallet.toLowerCase();
  const isMaker = event.maker === w;
  const isTaker = event.taker === w;
  if (!isMaker && !isTaker) return [];

  const makerAssetId = event.makerAssetId;
  const takerAssetId = event.takerAssetId;
  const makerAmount = tokenAmountToNumber(event.makerAmountFilled);
  const takerAmount = tokenAmountToNumber(event.takerAmountFilled);

  let side: "BUY" | "SELL";
  let asset: string;
  let shares: number;
  let cashUsd: number;

  if (isMaker) {
    if (makerAssetId === USDC_ASSET_ID) {
      side = "BUY";
      asset = takerAssetId;
      shares = takerAmount;
      cashUsd = makerAmount;
    } else {
      side = "SELL";
      asset = makerAssetId;
      shares = makerAmount;
      cashUsd = takerAmount;
    }
  } else if (makerAssetId === USDC_ASSET_ID) {
    side = "SELL";
    asset = takerAssetId;
    shares = takerAmount;
    cashUsd = makerAmount;
  } else {
    side = "BUY";
    asset = makerAssetId;
    shares = makerAmount;
    cashUsd = takerAmount;
  }

  if (!asset || asset === USDC_ASSET_ID || shares <= 0) return [];

  const type = side;
  const price = shares > 0 ? cashUsd / shares : 0;
  const ledgerEvent: WalletLedgerEvent = {
    wallet: w,
    conditionId: "",
    asset,
    timestamp,
    blockNumber: event.blockNumber,
    type,
    shares,
    cashUsd,
    price,
    txHash: event.transactionHash,
    source: "polygon",
    dedupeKey: buildLedgerEventDedupeKey({
      txHash: event.transactionHash,
      asset,
      timestamp,
      type,
      side,
      shares,
      price,
      cashUsd,
    }),
  };
  return [ledgerEvent];
}

export function parsedEventsToLedgerEvents(
  parsed: ParsedOnChainEvent[],
  wallet: string,
  blockTimestamps: Map<number, number>
): { events: WalletLedgerEvent[]; unparsed: ParsedOnChainEvent[] } {
  const w = wallet.toLowerCase();
  const events: WalletLedgerEvent[] = [];
  const unparsed: ParsedOnChainEvent[] = [];

  for (const item of parsed) {
    const blockNumber =
      item.type === "unparsed"
        ? Number.parseInt(item.raw.blockNumber, 16)
        : item.event.blockNumber;
    const timestamp = blockTimestamps.get(blockNumber) ?? 0;

    switch (item.type) {
      case "order_filled": {
        events.push(...orderFilledToLedgerEvents(item.event, w, timestamp));
        break;
      }
      case "payout_redemption": {
        if (item.event.redeemer !== w) break;
        const cashUsd = tokenAmountToNumber(item.event.payout);
        events.push({
          wallet: w,
          conditionId: item.event.conditionId,
          asset: "",
          timestamp,
          blockNumber: item.event.blockNumber,
          type: "REDEEM",
          shares: 0,
          cashUsd,
          txHash: item.event.transactionHash,
          source: "polygon",
          dedupeKey: buildLedgerEventDedupeKey({
            txHash: item.event.transactionHash,
            conditionId: item.event.conditionId,
            timestamp,
            type: "REDEEM",
            cashUsd,
          }),
        });
        break;
      }
      case "position_split": {
        if (item.event.stakeholder !== w) break;
        events.push({
          wallet: w,
          conditionId: item.event.conditionId,
          asset: "",
          timestamp,
          blockNumber: item.event.blockNumber,
          type: "SPLIT",
          shares: tokenAmountToNumber(item.event.amount),
          cashUsd: 0,
          txHash: item.event.transactionHash,
          source: "polygon",
          dedupeKey: buildLedgerEventDedupeKey({
            txHash: item.event.transactionHash,
            conditionId: item.event.conditionId,
            timestamp,
            type: "SPLIT",
            shares: tokenAmountToNumber(item.event.amount),
          }),
        });
        break;
      }
      case "positions_merge": {
        if (item.event.stakeholder !== w) break;
        events.push({
          wallet: w,
          conditionId: item.event.conditionId,
          asset: "",
          timestamp,
          blockNumber: item.event.blockNumber,
          type: "MERGE",
          shares: tokenAmountToNumber(item.event.amount),
          cashUsd: 0,
          txHash: item.event.transactionHash,
          source: "polygon",
          dedupeKey: buildLedgerEventDedupeKey({
            txHash: item.event.transactionHash,
            conditionId: item.event.conditionId,
            timestamp,
            type: "MERGE",
            shares: tokenAmountToNumber(item.event.amount),
          }),
        });
        break;
      }
      case "erc1155_transfer":
      case "condition_resolution":
      case "unparsed":
        unparsed.push(item);
        break;
      default:
        break;
    }
  }

  return { events, unparsed };
}

export function mergeApiAndChainEvents(
  apiEvents: WalletLedgerEvent[],
  chainEvents: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  const map = new Map<string, WalletLedgerEvent>();
  for (const event of apiEvents) {
    map.set(event.dedupeKey, event);
  }
  for (const event of chainEvents) {
    if (!map.has(event.dedupeKey)) {
      map.set(event.dedupeKey, event);
    }
  }
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}
