import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import type { ParsedOrderFilled } from "@/lib/walletLedger/onchain/types";
import { tokenAmountToNumber } from "@/lib/walletLedger/onchain/decode";

/** Exchange / infrastructure — never treated as the economic trader. */
export const TRADER_SYSTEM_ADDRESSES = new Set([
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

export interface TradeResolveContext {
  assetId?: string;
  side?: "BUY" | "SELL";
  sizeShares?: number;
}

export type EconomicResolveReason =
  | "matched_unique_trader"
  | "ambiguous_traders"
  | "no_asset_match"
  | "no_order_filled"
  | "amount_mismatch"
  | "missing_asset_id";

export interface EconomicResolveResult {
  wallet: string | null;
  reason: EconomicResolveReason;
  candidates: string[];
}

export function normalizeWalletAddress(wallet: string): string | null {
  const w = wallet.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w)) return null;
  return w;
}

export function isEconomicUserAddress(addr: string): boolean {
  const normalized = normalizeWalletAddress(addr);
  if (!normalized) return false;
  return !TRADER_SYSTEM_ADDRESSES.has(normalized);
}

export function assetsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

function outcomeAmountForAsset(
  event: ParsedOrderFilled,
  assetId: string
): bigint | null {
  if (assetsMatch(event.takerAssetId, assetId)) return event.takerAmountFilled;
  if (assetsMatch(event.makerAssetId, assetId)) return event.makerAmountFilled;
  return null;
}

function amountMatchesShares(amount: bigint, sizeShares: number): boolean {
  if (!Number.isFinite(sizeShares) || sizeShares <= 0) return true;
  const expected = BigInt(Math.round(sizeShares * 1_000_000));
  if (expected === 0n) return true;
  const diff = amount > expected ? amount - expected : expected - amount;
  const tolerance = expected / 100n + 10n;
  return diff <= tolerance;
}

/**
 * Pick the economic trader for one OrderFilled leg tied to the observed outcome asset.
 */
export function traderForMatchedFill(
  event: ParsedOrderFilled,
  assetId: string,
  side?: "BUY" | "SELL"
): string | null {
  const makerHasOutcome = assetsMatch(event.makerAssetId, assetId);
  const takerHasOutcome = assetsMatch(event.takerAssetId, assetId);
  if (!makerHasOutcome && !takerHasOutcome) return null;

  if (side === "BUY") {
    if (takerHasOutcome && isEconomicUserAddress(event.taker)) return event.taker;
    if (makerHasOutcome && isEconomicUserAddress(event.maker)) return event.maker;
    return null;
  }
  if (side === "SELL") {
    if (makerHasOutcome && isEconomicUserAddress(event.maker)) return event.maker;
    if (takerHasOutcome && isEconomicUserAddress(event.taker)) return event.taker;
    return null;
  }

  const candidates = new Set<string>();
  if (makerHasOutcome && isEconomicUserAddress(event.maker)) {
    candidates.add(event.maker);
  }
  if (takerHasOutcome && isEconomicUserAddress(event.taker)) {
    candidates.add(event.taker);
  }
  if (candidates.size === 1) return [...candidates][0] ?? null;
  return null;
}

export function resolveTraderFromOrderFilledEvents(
  events: ParsedOrderFilled[],
  ctx: TradeResolveContext
): EconomicResolveResult {
  if (!ctx.assetId?.trim()) {
    return {
      wallet: null,
      reason: "missing_asset_id",
      candidates: [],
    };
  }
  const assetId = ctx.assetId.trim();
  if (events.length === 0) {
    return { wallet: null, reason: "no_order_filled", candidates: [] };
  }

  const tradersLoose = new Set<string>();
  const tradersAmountMatched = new Set<string>();
  for (const event of events) {
    if (
      !assetsMatch(event.makerAssetId, assetId) &&
      !assetsMatch(event.takerAssetId, assetId)
    ) {
      continue;
    }
    const trader = traderForMatchedFill(event, assetId, ctx.side);
    if (!trader) continue;
    tradersLoose.add(trader);
    const amount = outcomeAmountForAsset(event, assetId);
    if (
      amount != null &&
      ctx.sizeShares != null &&
      amountMatchesShares(amount, ctx.sizeShares)
    ) {
      tradersAmountMatched.add(trader);
    }
  }

  const traders =
    tradersAmountMatched.size > 0 ? tradersAmountMatched : tradersLoose;

  if (traders.size === 0) {
    return { wallet: null, reason: "no_asset_match", candidates: [] };
  }
  if (traders.size > 1) {
    return {
      wallet: null,
      reason: "ambiguous_traders",
      candidates: [...traders],
    };
  }
  return {
    wallet: [...traders][0] ?? null,
    reason: "matched_unique_trader",
    candidates: [...traders],
  };
}

export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string;
  blockNumber?: string;
}

export function resolveTraderFromReceiptLogs(
  logs: ReceiptLog[],
  ctx: TradeResolveContext
): EconomicResolveResult {
  const orderFilled: ParsedOrderFilled[] = [];
  for (const log of logs) {
    const parsed = decodeLog({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: log.blockNumber ?? "0x0",
      transactionHash: "0x0",
      logIndex: log.logIndex ?? "0x0",
    });
    if (parsed.type === "order_filled") {
      orderFilled.push(parsed.event);
    }
  }
  return resolveTraderFromOrderFilledEvents(orderFilled, ctx);
}

/** Diagnostic: outcome token amount in human shares for a fill. */
export function fillOutcomeShares(
  event: ParsedOrderFilled,
  assetId: string
): number | null {
  const amount = outcomeAmountForAsset(event, assetId);
  if (amount == null) return null;
  return tokenAmountToNumber(amount);
}
