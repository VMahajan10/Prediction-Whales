import {
  ClosingLineFileCache,
  computeClosingLineVwapFirst,
  type ClosingLineResult,
} from "@/lib/backtest/closingLineService";
import type { ClosingLinePolicyConfig } from "@/lib/backtest/marketSchedule";
import type { MarketSchedule } from "@/lib/backtest/marketSchedule";
import { MarketTradeTapeCache } from "@/lib/backtest/marketTradeTape";
import type { BacktestFill, MarketResolution, TradeClvRecord } from "@/lib/backtest/types";
import { outcomeLabelForToken } from "@/lib/backtest/marketMeta";
import { CLV_CONSTANTS, mapWithConcurrency } from "@/lib/clvPriceHistory";

export { ClosingLineFileCache } from "@/lib/backtest/closingLineService";

export function clvToCents(clvPriceDelta: number): number {
  return Math.round(clvPriceDelta * 100 * 10) / 10;
}

function baseTradeRecordFields(
  fill: BacktestFill,
  resolution?: MarketResolution
): Pick<
  TradeClvRecord,
  "marketId" | "marketTitle" | "outcome" | "tokenId"
> {
  const marketTitle =
    fill.marketTitle ?? resolution?.marketTitle ?? null;
  const outcome =
    fill.outcome ??
    (resolution ? outcomeLabelForToken(resolution, fill.assetId) : null);
  return {
    marketId: fill.conditionId,
    marketTitle,
    outcome,
    tokenId: fill.assetId,
  };
}

export function buildTradeClvRecord(
  fill: BacktestFill,
  closing: ClosingLineResult,
  resolution: MarketResolution | undefined,
  schedule: MarketSchedule | undefined,
  heldAssetSettled: 0 | 1 | undefined,
  marketExclusion?: TradeClvRecord["exclusionReason"],
  rankingEligible = true
): TradeClvRecord {
  const base = baseTradeRecordFields(fill, resolution);

  if (marketExclusion) {
    return {
      ...fill,
      ...base,
      closingLinePrice: null,
      closeTimestamp: null,
      clvCents: null,
      isValidClv: false,
      exclusionReason: marketExclusion,
      rankingEligible,
      heldAssetSettled,
      closingLineSource: null,
      closingCutoffUnix: schedule?.closingCutoffUnix ?? null,
    };
  }

  if (!closing.valid || closing.closingLine == null) {
    return {
      ...fill,
      ...base,
      closingLinePrice: null,
      closeTimestamp: closing.closeTimestamp,
      clvCents: null,
      isValidClv: false,
      exclusionReason:
        (closing.reason as TradeClvRecord["exclusionReason"]) ??
        "missing_closing_price",
      rankingEligible,
      heldAssetSettled,
      closingLineSource: closing.source,
      closingCutoffUnix: schedule?.closingCutoffUnix ?? null,
    };
  }

  const clvCents = clvToCents(closing.closingLine - fill.price);
  return {
    ...fill,
    ...base,
    closingLinePrice: closing.closingLine,
    closeTimestamp: closing.closeTimestamp,
    clvCents,
    isValidClv: true,
    rankingEligible,
    heldAssetSettled,
    closingLineSource: closing.source,
    closingCutoffUnix: schedule?.closingCutoffUnix ?? null,
  };
}

export async function computeClvForFills(
  fills: BacktestFill[],
  settledByFill: Map<string, 0 | 1>,
  schedules: Map<string, MarketSchedule>,
  resolutions: Map<string, MarketResolution>,
  policy: ClosingLinePolicyConfig,
  tapeCache: MarketTradeTapeCache,
  fileCache: ClosingLineFileCache,
  marketExcluded: Map<string, TradeClvRecord["exclusionReason"]>,
  rankingEligibleByFill: Map<string, boolean>
): Promise<TradeClvRecord[]> {
  const fillKey = (f: BacktestFill) =>
    `${f.walletAddress}:${f.timestamp}:${f.assetId}:${f.price}`;

  return mapWithConcurrency(
    fills,
    CLV_CONSTANTS.FETCH_CONCURRENCY,
    async (fill) => {
      const key = fillKey(fill);
      const resolution = resolutions.get(fill.conditionId);
      const schedule = schedules.get(fill.conditionId);
      const marketReason = marketExcluded.get(key);
      const settled = settledByFill.get(key);
      const rankingEligible = rankingEligibleByFill.get(key) ?? true;

      if (marketReason || settled == null) {
        return buildTradeClvRecord(
          fill,
          {
            closingLine: null,
            closeTimestamp: null,
            valid: false,
            reason: marketReason ?? "unresolved_market",
            source: null,
          },
          resolution,
          schedule,
          settled,
          marketReason ?? "unresolved_market",
          rankingEligible
        );
      }

      const cutoff = schedule?.closingCutoffUnix;
      if (cutoff == null) {
        return buildTradeClvRecord(
          fill,
          {
            closingLine: null,
            closeTimestamp: null,
            valid: false,
            reason: "invalid_close_time",
            source: null,
          },
          resolution,
          schedule,
          settled,
          "missing_closing_price",
          rankingEligible
        );
      }

      const closing = await computeClosingLineVwapFirst(
        fill.assetId,
        fill.conditionId,
        cutoff,
        policy,
        tapeCache,
        fileCache
      );
      return buildTradeClvRecord(
        fill,
        closing,
        resolution,
        schedule,
        settled,
        undefined,
        rankingEligible
      );
    }
  );
}

export interface WalletClvAggregate {
  walletAddress: string;
  qualifyingTrades: number;
  validClvTrades: number;
  unweightedClvCents: number | null;
  weightedClvCents: number | null;
}

export function rankWalletsByClv(
  records: TradeClvRecord[],
  minTrades: number
): WalletClvAggregate[] {
  const byWallet = new Map<string, TradeClvRecord[]>();
  for (const r of records) {
    if (!r.rankingEligible) continue;
    if (
      r.exclusionReason === "unresolved_market" ||
      r.exclusionReason === "disputed_market" ||
      r.exclusionReason === "missing_condition" ||
      r.exclusionReason === "missing_asset" ||
      r.exclusionReason === "unresolved_at_window_end"
    ) {
      continue;
    }
    const w = r.walletAddress.toLowerCase();
    const list = byWallet.get(w) ?? [];
    list.push(r);
    byWallet.set(w, list);
  }

  const rows: WalletClvAggregate[] = [];
  for (const [wallet, trades] of byWallet) {
    if (trades.length < minTrades) continue;
    const valid = trades.filter((t) => t.isValidClv && t.clvCents != null);
    const unweighted =
      valid.length > 0
        ? valid.reduce((s, t) => s + t.clvCents!, 0) / valid.length
        : null;
    const totalUsd = valid.reduce((s, t) => s + t.sizeUsd, 0);
    const weighted =
      totalUsd > 0
        ? valid.reduce((s, t) => s + t.clvCents! * t.sizeUsd, 0) / totalUsd
        : null;
    rows.push({
      walletAddress: wallet,
      qualifyingTrades: trades.length,
      validClvTrades: valid.length,
      unweightedClvCents: unweighted,
      weightedClvCents: weighted,
    });
  }

  rows.sort(
    (a, b) =>
      (b.weightedClvCents ?? -Infinity) - (a.weightedClvCents ?? -Infinity)
  );
  return rows;
}
