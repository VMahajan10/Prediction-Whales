import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { lastMidpointBeforeClose } from "@/lib/backtest/closingPrice";
import type { ClosingLinePolicyConfig } from "@/lib/backtest/marketSchedule";
import {
  fetchConditionTradeTape,
  MarketTradeTapeCache,
  vwapClosingFromTape,
} from "@/lib/backtest/marketTradeTape";
import { fetchTokenPriceHistory } from "@/lib/backtest/priceHistory";
import type { ClosingLineCacheEntry } from "@/lib/backtest/types";

export interface ClosingLineResult {
  closingLine: number | null;
  closeTimestamp: number | null;
  valid: boolean;
  reason?: string;
  source: "tape" | "clob" | null;
}

function cacheKey(
  assetId: string,
  cutoffUnix: number,
  lastN: number
): string {
  return `${assetId}\t${cutoffUnix}\t${lastN}`;
}

export class ClosingLineFileCache {
  private readonly path: string;
  private readonly map = new Map<string, ClosingLineCacheEntry>();

  constructor(jsonlPath: string) {
    this.path = jsonlPath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as ClosingLineCacheEntry;
        if (entry.schemaVersion !== 3 || !entry.assetId) continue;
        if (!Number.isFinite(entry.closingCutoffUnix)) continue;
        this.map.set(
          cacheKey(entry.assetId, entry.closingCutoffUnix, entry.vwapTradeCount ?? 10),
          entry
        );
      } catch {
        // skip
      }
    }
  }

  get(
    assetId: string,
    cutoffUnix: number,
    lastN: number
  ): ClosingLineCacheEntry | undefined {
    return this.map.get(cacheKey(assetId, cutoffUnix, lastN));
  }

  set(entry: ClosingLineCacheEntry): void {
    const key = cacheKey(
      entry.assetId,
      entry.closingCutoffUnix,
      entry.vwapTradeCount ?? 10
    );
    if (this.map.has(key)) return;
    this.map.set(key, entry);
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

export async function computeClosingLineVwapFirst(
  assetId: string,
  conditionId: string,
  cutoffUnix: number,
  policy: ClosingLinePolicyConfig,
  tapeCache: MarketTradeTapeCache,
  fileCache: ClosingLineFileCache
): Promise<ClosingLineResult> {
  if (!Number.isFinite(cutoffUnix) || cutoffUnix <= 0) {
    return {
      closingLine: null,
      closeTimestamp: null,
      valid: false,
      reason: "invalid_close_time",
      source: null,
    };
  }

  const cached = fileCache.get(assetId, cutoffUnix, policy.vwapTradeCount);
  if (cached) {
    if (!cached.valid || cached.closingLine == null) {
      return {
        closingLine: null,
        closeTimestamp: null,
        valid: false,
        reason: cached.reason ?? "missing_closing_price",
        source: cached.historySource === "clob" ? "clob" : null,
      };
    }
    return {
      closingLine: cached.closingLine,
      closeTimestamp: cached.pricePointTimestamp,
      valid: true,
      source: cached.historySource === "tape" ? "tape" : "clob",
    };
  }

  let tape = tapeCache.get(conditionId);
  if (!tape) {
    tape = await fetchConditionTradeTape(conditionId);
    tapeCache.set(conditionId, tape);
  }

  const tapeResult = vwapClosingFromTape(
    tape,
    assetId,
    cutoffUnix,
    policy.vwapTradeCount,
    policy.minTapeTrades
  );

  if (tapeResult.valid && tapeResult.closingLine != null) {
    const entry: ClosingLineCacheEntry = {
      schemaVersion: 3,
      assetId,
      closingCutoffUnix: cutoffUnix,
      vwapTradeCount: policy.vwapTradeCount,
      closingLine: tapeResult.closingLine,
      pricePointTimestamp: tapeResult.closeTimestamp,
      valid: true,
      historySource: "tape",
    };
    fileCache.set(entry);
    return {
      closingLine: tapeResult.closingLine,
      closeTimestamp: tapeResult.closeTimestamp,
      valid: true,
      source: "tape",
    };
  }

  const { points, source } = await fetchTokenPriceHistory(assetId);
  const clob = lastMidpointBeforeClose(points, cutoffUnix);
  const cacheEntry: ClosingLineCacheEntry = {
    schemaVersion: 3,
    assetId,
    closingCutoffUnix: cutoffUnix,
    vwapTradeCount: policy.vwapTradeCount,
    closingLine: clob.valid ? clob.closingLine : null,
    pricePointTimestamp: clob.closeTimestamp,
    valid: clob.valid,
    reason: clob.reason,
    historySource: clob.valid ? "clob" : source,
  };
  fileCache.set(cacheEntry);

  if (!clob.valid || clob.closingLine == null) {
    return {
      closingLine: null,
      closeTimestamp: null,
      valid: false,
      reason: clob.reason ?? "missing_closing_price",
      source: null,
    };
  }

  return {
    closingLine: clob.closingLine,
    closeTimestamp: clob.closeTimestamp,
    valid: true,
    source: "clob",
  };
}

export function closingLineLeakageShare(
  records: Array<{ closingLinePrice: number | null; isValidClv: boolean }>
): number {
  const valid = records.filter((r) => r.isValidClv && r.closingLinePrice != null);
  if (valid.length === 0) return 0;
  const leaky = valid.filter(
    (r) => r.closingLinePrice! > 0.95 || r.closingLinePrice! < 0.05
  );
  return leaky.length / valid.length;
}
