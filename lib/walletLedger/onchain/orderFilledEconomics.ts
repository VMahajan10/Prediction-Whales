import { assetsMatch } from "@/lib/resolveWhaleWalletEconomic";
import { tokenAmountToNumber } from "@/lib/walletLedger/onchain/decode";
import type { ParsedOrderFilled } from "@/lib/walletLedger/onchain/types";

/** Polymarket CTF exchanges use asset id 0 for USDC collateral. */
export function isExchangeCollateralAssetId(assetId: string): boolean {
  return assetId === "0";
}

/** Outcome ERC-1155 id (neg-risk fills may pair a compact id like `1` with the real token id). */
export function resolveOutcomeAssetId(
  makerAssetId: string,
  takerAssetId: string
): string | null {
  const maker = makerAssetId?.trim() ?? "";
  const taker = takerAssetId?.trim() ?? "";
  if (!maker || !taker) return null;
  if (isExchangeCollateralAssetId(maker)) return taker;
  if (isExchangeCollateralAssetId(taker)) return maker;
  const makerLong = maker.length > 16;
  const takerLong = taker.length > 16;
  if (makerLong && !takerLong) return maker;
  if (takerLong && !makerLong) return taker;
  return null;
}

export interface OrderFilledLegEconomics {
  side: "BUY" | "SELL";
  asset: string;
  shares: number;
  cashUsd: number;
}

/**
 * Map one OrderFilled leg to BUY/SELL economics for `wallet` (maker or taker).
 * Handles binary v1 (USDC id 0) and neg-risk exchange (compact id + full token id).
 */
export function deriveOrderFilledLegEconomics(
  event: ParsedOrderFilled,
  wallet: string
): OrderFilledLegEconomics | null {
  const w = wallet.toLowerCase();
  const isMaker = event.maker === w;
  const isTaker = event.taker === w;
  if (!isMaker && !isTaker) return null;

  const outcome = resolveOutcomeAssetId(event.makerAssetId, event.takerAssetId);
  if (!outcome || isExchangeCollateralAssetId(outcome)) return null;

  const makerAmt = tokenAmountToNumber(event.makerAmountFilled);
  const takerAmt = tokenAmountToNumber(event.takerAmountFilled);
  const makerIsOutcome = assetsMatch(event.makerAssetId, outcome);
  const takerIsOutcome = assetsMatch(event.takerAssetId, outcome);

  if (isMaker) {
    if (isExchangeCollateralAssetId(event.makerAssetId)) {
      return { side: "BUY", asset: outcome, shares: takerAmt, cashUsd: makerAmt };
    }
    if (makerIsOutcome || takerIsOutcome) {
      return { side: "SELL", asset: outcome, shares: makerAmt, cashUsd: takerAmt };
    }
    return null;
  }

  if (isExchangeCollateralAssetId(event.takerAssetId)) {
    return { side: "BUY", asset: outcome, shares: makerAmt, cashUsd: takerAmt };
  }
  if (makerIsOutcome || takerIsOutcome) {
    return { side: "SELL", asset: outcome, shares: takerAmt, cashUsd: makerAmt };
  }
  return null;
}
