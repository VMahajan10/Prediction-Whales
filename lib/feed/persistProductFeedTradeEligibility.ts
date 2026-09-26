import "server-only";

import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { feedTradeEligibility } from "@/lib/crossmarket/store/schema";
import {
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
  passesPolymarketFeedTraderGate,
  resolvePolymarketTradeNotionalUsd,
  resolveProductFeedWalletBlockReason,
  type ProductFeedWalletBlockReason,
} from "@/lib/feedQualification";
import { evaluateLiveFeedTradeGate } from "@/lib/feedGate";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import {
  PRODUCT_FEED_ATTRIBUTION_RESOLVER_VERSION,
  PRODUCT_FEED_GATE_VERSION,
} from "@/lib/feed/productFeedGateVersion";
import type { FeedTradeHistoryInput } from "@/lib/feed/feedTradeHistoryCore";
import type {
  PolymarketFeedTradeLike,
  WalletFeedQualification,
} from "@/lib/feedQualificationServer";

export type ProductFeedTradeEligibilityBlockReason =
  | ProductFeedWalletBlockReason
  | "trade_stake_below_minimum"
  | "trade_ev_below_minimum"
  | "trade_ev_missing"
  | "wallet_missing"
  | "other";

export type ProductFeedTradeEligibilityRow = {
  tradeId: string;
  productFeedGateVersion: string;
  evaluatedAt: Date;
  tradedAt: Date;
  walletAddress: string | null;
  attributionResolverVersion: string;
  tradeStakePass: boolean;
  tradeEvPass: boolean;
  walletGatePass: boolean;
  finalEligible: boolean;
  blockReason: ProductFeedTradeEligibilityBlockReason | null;
  stakeUsd: number;
  tradeEvPct: number | null;
  historicalVolumeUsd: number | null;
  historicalVolumeReason: string | null;
};

type TradeWithTimestamp = PolymarketFeedTradeLike & {
  timestamp?: number;
};

export function buildProductFeedTradeEligibilityRow(input: {
  trade: TradeWithTimestamp;
  tradeEvPercent: number | null;
  qualification: WalletFeedQualification | undefined;
  evaluatedAt?: Date;
  productFeedGateVersion?: string;
}): ProductFeedTradeEligibilityRow {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const stakeUsd = resolvePolymarketTradeNotionalUsd(input.trade);
  const tradeEvPercent = input.tradeEvPercent;
  const tradeStakePass = meetsProductFeedStakeThreshold(stakeUsd);
  const tradeEvPass =
    tradeEvPercent != null &&
    Number.isFinite(tradeEvPercent) &&
    meetsFeedTradeEvThreshold(tradeEvPercent);

  const category = resolveFeedFilterCategoryLabel(input.trade);
  const tradeGatePass = evaluateLiveFeedTradeGate(
    {
      stakeUsd,
      title: input.trade.title,
      slug: input.trade.slug,
      eventSlug: input.trade.eventSlug,
      category,
      tradeEvPercent,
    },
    { id: input.trade.id, source: "api", logRejection: false }
  ).passed;

  const wallet = input.trade.proxyWallet?.trim().toLowerCase() ?? null;
  const qualification = wallet ? input.qualification : undefined;

  let walletGatePass = false;
  let blockReason: ProductFeedTradeEligibilityBlockReason | null = null;

  if (!tradeStakePass) {
    blockReason = "trade_stake_below_minimum";
  } else if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) {
    blockReason = "trade_ev_missing";
  } else if (!tradeEvPass) {
    blockReason = "trade_ev_below_minimum";
  } else if (!wallet) {
    blockReason = "wallet_missing";
  } else {
    walletGatePass = passesPolymarketFeedTraderGate(wallet, qualification);
    if (!walletGatePass) {
      blockReason =
        qualification?.productFeedWalletBlockReason ??
        resolveProductFeedWalletBlockReason({
          walletInRegistry: qualification != null,
          hydrationState: qualification?.hydrationState ?? "pending",
          resolvedBetsCount: qualification?.resolvedBetsCount,
          resolvedVolumeUSD: qualification?.resolvedVolumeUSD,
          historicalResolvedVolumeTrusted:
            qualification?.historicalResolvedVolumeTrusted,
          historicalVolumeGateReason: qualification?.historicalVolumeGateReason,
        }) ??
        "other";
    }
  }

  const finalEligible =
    tradeGatePass &&
    wallet != null &&
    passesPolymarketFeedTraderGate(wallet, qualification);

  if (!finalEligible && blockReason == null) {
    blockReason = "other";
  }

  const tradedAt =
    input.trade.timestamp != null &&
    Number.isFinite(input.trade.timestamp) &&
    input.trade.timestamp > 0
      ? new Date(input.trade.timestamp * 1000)
      : evaluatedAt;

  return {
    tradeId: input.trade.id,
    productFeedGateVersion:
      input.productFeedGateVersion ?? PRODUCT_FEED_GATE_VERSION,
    evaluatedAt,
    tradedAt,
    walletAddress: wallet,
    attributionResolverVersion: PRODUCT_FEED_ATTRIBUTION_RESOLVER_VERSION,
    tradeStakePass,
    tradeEvPass,
    walletGatePass,
    finalEligible,
    blockReason: finalEligible ? null : blockReason,
    stakeUsd,
    tradeEvPct: tradeEvPercent,
    historicalVolumeUsd: qualification?.historicalVolumeUsd ?? null,
    historicalVolumeReason: qualification?.historicalVolumeReason ?? null,
  };
}

export function buildProductFeedTradeEligibilityRows<
  T extends TradeWithTimestamp,
>(input: {
  trades: T[];
  tradeEvPercents: Map<string, number | null>;
  walletQualifications: Record<string, WalletFeedQualification>;
  evaluatedAt?: Date;
}): ProductFeedTradeEligibilityRow[] {
  return input.trades.map((trade) => {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    return buildProductFeedTradeEligibilityRow({
      trade,
      tradeEvPercent: input.tradeEvPercents.get(trade.id) ?? null,
      qualification: wallet ? input.walletQualifications[wallet] : undefined,
      evaluatedAt: input.evaluatedAt,
    });
  });
}

/** Best-effort persistence — must not affect feed qualification outcomes. */
export async function persistProductFeedTradeEligibilityRows(
  rows: ProductFeedTradeEligibilityRow[]
): Promise<void> {
  if (!isDatabaseEnabled() || rows.length === 0) return;

  const db = getDb();
  const values = rows.map((row) => ({
    tradeId: row.tradeId,
    productFeedGateVersion: row.productFeedGateVersion,
    evaluatedAt: row.evaluatedAt,
    tradedAt: row.tradedAt,
    walletAddress: row.walletAddress,
    attributionResolverVersion: row.attributionResolverVersion,
    tradeStakePass: row.tradeStakePass,
    tradeEvPass: row.tradeEvPass,
    walletGatePass: row.walletGatePass,
    finalEligible: row.finalEligible,
    blockReason: row.blockReason,
    stakeUsd: row.stakeUsd,
    tradeEvPct: row.tradeEvPct,
    historicalVolumeUsd: row.historicalVolumeUsd,
    historicalVolumeReason: row.historicalVolumeReason,
  }));

  await db
    .insert(feedTradeEligibility)
    .values(values)
    .onConflictDoUpdate({
      target: [
        feedTradeEligibility.tradeId,
        feedTradeEligibility.productFeedGateVersion,
      ],
      set: {
        evaluatedAt: sql`excluded.evaluated_at`,
        tradedAt: sql`excluded.traded_at`,
        walletAddress: sql`excluded.wallet_address`,
        attributionResolverVersion: sql`excluded.attribution_resolver_version`,
        tradeStakePass: sql`excluded.trade_stake_pass`,
        tradeEvPass: sql`excluded.trade_ev_pass`,
        walletGatePass: sql`excluded.wallet_gate_pass`,
        finalEligible: sql`excluded.final_eligible`,
        blockReason: sql`excluded.block_reason`,
        stakeUsd: sql`excluded.stake_usd`,
        tradeEvPct: sql`excluded.trade_ev_pct`,
        historicalVolumeUsd: sql`excluded.historical_volume_usd`,
        historicalVolumeReason: sql`excluded.historical_volume_reason`,
        updatedAt: sql`now()`,
      },
    });
}

function feedHistoryInputToPersistTrade(
  input: FeedTradeHistoryInput
): TradeWithTimestamp {
  const payload =
    input.payload != null && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : {};
  const price =
    typeof payload.price === "number" && Number.isFinite(payload.price)
      ? payload.price
      : 0.5;
  const size =
    typeof payload.size === "number" && Number.isFinite(payload.size)
      ? payload.size
      : input.stakeAmountUsd / Math.max(price, 0.01);

  return {
    id: input.id,
    price,
    size,
    proxyWallet: input.proxyWallet,
    title: input.title,
    outcome: typeof payload.outcome === "string" ? payload.outcome : "Yes",
    side: payload.side === "SELL" ? "SELL" : "BUY",
    slug: typeof payload.slug === "string" ? payload.slug : null,
    eventSlug:
      typeof payload.eventSlug === "string" ? payload.eventSlug : null,
    assetId: typeof payload.assetId === "string" ? payload.assetId : null,
    timestamp: input.timestamp,
  };
}

/** Persist Option 1 decisions for trades written to feed_trades (socket + /api/feed). */
export function schedulePersistProductFeedTradeEligibilityFromFeedHistory(
  trades: FeedTradeHistoryInput[],
  walletQualifications: Record<string, WalletFeedQualification>
): void {
  if (trades.length === 0) return;
  const tradeEvPercents = new Map(
    trades.map((trade) => [trade.id, trade.averageEvPercent])
  );
  schedulePersistProductFeedTradeEligibility({
    trades: trades.map(feedHistoryInputToPersistTrade),
    tradeEvPercents,
    walletQualifications,
  });
}

export function schedulePersistProductFeedTradeEligibility<
  T extends TradeWithTimestamp,
>(input: {
  trades: T[];
  tradeEvPercents: Map<string, number | null>;
  walletQualifications: Record<string, WalletFeedQualification>;
}): void {
  if (!isDatabaseEnabled() || input.trades.length === 0) return;
  const rows = buildProductFeedTradeEligibilityRows(input);
  void persistProductFeedTradeEligibilityRows(rows).catch((error) => {
    console.warn(
      "[persistProductFeedTradeEligibility] failed (non-fatal)",
      error instanceof Error ? error.message : error
    );
  });
}
