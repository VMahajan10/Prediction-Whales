#!/usr/bin/env tsx
/**
 * Per-market ledger vs Polymarket positions/activity for wallet 3 reconciliation.
 */
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  walletPositionLifecycles,
  walletHistoricalMetrics,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { fetchActivityHistory, fetchPositionsSnapshot } from "@/lib/walletLedger/fetchers";
import { fetchClosedPositions } from "@/lib/polymarket";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import type { ActivityApiRow, PositionApiRow } from "@/lib/walletLedger/types";

const WALLET =
  process.argv[2]?.toLowerCase() ??
  "0xad529df14c293d77984a0137990a1441b25211ac";

const FLAG_THRESHOLD_USD = 50;

async function fetchLeaderboardPnl(wallet: string): Promise<number | null> {
  const res = await fetchWithTimeout(
    `https://data-api.polymarket.com/v1/leaderboard?user=${wallet}&timePeriod=all&orderBy=PNL&limit=1`,
    { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { pnl?: number; proxyWallet?: string }[];
  const row = Array.isArray(data) ? data[0] : null;
  return typeof row?.pnl === "number" ? row.pnl : null;
}

async function fetchGammaProxy(wallet: string): Promise<string | null> {
  const res = await fetchWithTimeout(
    `https://gamma-api.polymarket.com/public-profile?address=${wallet}`,
    { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { proxyWallet?: string };
  return data.proxyWallet?.toLowerCase() ?? null;
}

interface LedgerAssetAgg {
  assetId: string;
  conditionId: string;
  title: string | null;
  buyNotional: number;
  sellNotional: number;
  resolutionPayout: number;
  ledgerRealizedPnl: number;
  resolutionOutcome: string;
  lifecycleRows: number;
  completedEpisodes: number;
  exclusionSample: string | null;
}

function activityPnlByAsset(rows: ActivityApiRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const asset = r.asset?.trim();
    if (!asset) continue;
    const usdc = Number(r.usdcSize ?? 0);
    if (!Number.isFinite(usdc)) continue;
    const t = (r.type ?? "").toUpperCase();
    const side = (r.side ?? "").toUpperCase();
    let delta = 0;
    if (t === "TRADE") {
      if (side === "BUY") delta = -usdc;
      else if (side === "SELL") delta = usdc;
    } else if (
      t === "REDEEM" ||
      t === "MERGE" ||
      t === "SPLIT" ||
      t === "REWARD" ||
      t === "CONVERSION"
    ) {
      delta = usdc;
    }
    if (delta !== 0) {
      map.set(asset, (map.get(asset) ?? 0) + delta);
    }
  }
  return map;
}

function activityMetaByAsset(
  rows: ActivityApiRow[]
): Map<string, { title: string; conditionId: string }> {
  const map = new Map<string, { title: string; conditionId: string }>();
  for (const r of rows) {
    const asset = r.asset?.trim();
    if (!asset || map.has(asset)) continue;
    map.set(asset, {
      title: r.title ?? r.slug ?? asset.slice(0, 12),
      conditionId: r.conditionId ?? "",
    });
  }
  return map;
}

async function loadLedgerByAsset(wallet: string): Promise<Map<string, LedgerAssetAgg>> {
  const db = getDb();
  if (!db) return new Map();

  const rows = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      and(
        sql`lower(${walletPositionLifecycles.walletAddress}) = ${wallet}`,
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  const byAsset = new Map<string, LedgerAssetAgg>();
  for (const r of rows) {
    const key = r.assetId;
    let agg = byAsset.get(key);
    if (!agg) {
      agg = {
        assetId: key,
        conditionId: r.conditionId,
        title: null,
        buyNotional: 0,
        sellNotional: 0,
        resolutionPayout: 0,
        ledgerRealizedPnl: 0,
        resolutionOutcome:
          r.resolutionFinal === true
            ? r.outcomeWin === true
              ? "won (held)"
              : r.outcomeWin === false
                ? "lost (held)"
                : "resolved"
            : r.resolutionFinal === false
              ? "open/unresolved"
              : "—",
        lifecycleRows: 0,
        completedEpisodes: 0,
        exclusionSample: null,
      };
      byAsset.set(key, agg);
    }
    agg.lifecycleRows += 1;
    agg.buyNotional += r.buyNotional ?? 0;
    agg.sellNotional += r.sellNotional ?? 0;
    agg.resolutionPayout += r.resolutionPayout ?? 0;
    if (r.completed && r.realizedPnl != null) {
      agg.completedEpisodes += 1;
      agg.ledgerRealizedPnl += r.realizedPnl;
    }
    if (r.exclusionReason && !agg.exclusionSample) {
      agg.exclusionSample = r.exclusionReason;
    }
    if (r.resolutionFinal === true && agg.resolutionOutcome === "—") {
      agg.resolutionOutcome =
        r.outcomeWin === true ? "won (held)" : r.outcomeWin === false ? "lost (held)" : "resolved";
    }
  }
  return byAsset;
}

function apiPositionPnl(p: PositionApiRow): number {
  const realized = Number(p.realizedPnl ?? 0);
  const size = Number(p.size ?? 0);
  const redeemable = Boolean(p.redeemable);
  if (size > 0.01 && redeemable) {
    const cash = Number(p.cashPnl ?? 0);
    return realized + cash;
  }
  return realized;
}

async function main() {
  console.log("Wallet 3 reconciliation");
  console.log("=".repeat(72));
  console.log(`Address: ${WALLET}`);

  const [gammaProxy, leaderboardPnl] = await Promise.all([
    fetchGammaProxy(WALLET),
    fetchLeaderboardPnl(WALLET),
  ]);
  console.log(`\nGamma proxyWallet: ${gammaProxy ?? "—"}`);
  console.log(
    `Proxy match: ${gammaProxy === WALLET ? "YES (query address is the proxy)" : gammaProxy ? `NO — use ${gammaProxy}` : "unknown"}`
  );
  console.log(
    `Profile PnL (leaderboard all-time): $${leaderboardPnl?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "n/a"}`
  );

  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const db = getDb()!;
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        sql`lower(${walletHistoricalMetrics.walletAddress}) = ${WALLET}`,
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);

  const ledgerByAsset = await loadLedgerByAsset(WALLET);
  console.log(`\nLedger: ${ledgerByAsset.size} unique assets (lifecycles aggregated)`);
  if (metrics) {
    console.log(
      `Indexed metrics: completed=${metrics.completedPositions} net_realized=${metrics.netRealizedPnl} history_complete=${metrics.historyComplete}`
    );
  }

  const [activity, closedPositions] = await Promise.all([
    fetchActivityHistory(WALLET),
    fetchClosedPositions(WALLET),
  ]);
  const openPositions: PositionApiRow[] = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const res = await fetchWithTimeout(
      `https://data-api.polymarket.com/positions?user=${WALLET}&limit=500&offset=${offset}`,
      { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
    );
    if (!res.ok) break;
    const page = (await res.json()) as PositionApiRow[];
    if (!Array.isArray(page) || page.length === 0) break;
    openPositions.push(...page);
    if (page.length < 500) break;
  }

  console.log(
    `\nData API: activity=${activity.rows.length} truncated=${activity.truncated} | open positions=${openPositions.length} | closed-positions cap=${closedPositions.length}`
  );

  const activityPnl = activityPnlByAsset(activity.rows);
  const activityMeta = activityMetaByAsset(activity.rows);

  const apiByAsset = new Map<
    string,
    { pnl: number; source: string; totalBought?: number; title?: string }
  >();

  for (const p of openPositions) {
    const asset = p.asset?.trim();
    if (!asset) continue;
    apiByAsset.set(asset, {
      pnl: apiPositionPnl(p),
      source: "positions",
      totalBought: Number(p.totalBought ?? 0),
      title: p.title,
    });
  }

  for (const p of closedPositions) {
    const asset = String(p.asset ?? p.assetId ?? "").trim();
    if (!asset) continue;
    const existing = apiByAsset.get(asset);
    const pnl = Number(p.realizedPnl ?? 0);
    if (!existing || existing.source !== "closed-positions") {
      apiByAsset.set(asset, {
        pnl,
        source: "closed-positions",
        totalBought: Number(p.totalBought ?? 0),
        title: p.title,
      });
    }
  }

  const allAssets = new Set<string>([
    ...ledgerByAsset.keys(),
    ...apiByAsset.keys(),
    ...activityPnl.keys(),
  ]);

  const rows: {
    title: string;
    assetId: string;
    ledgerBuy: number;
    ledgerSell: number;
    resolution: string;
    ledgerPnl: number;
    apiPnl: number | null;
    apiSource: string;
    diff: number | null;
    reason: string | null;
  }[] = [];

  for (const asset of allAssets) {
    const ledger = ledgerByAsset.get(asset);
    const meta = activityMeta.get(asset);
    const api = apiByAsset.get(asset);
    const actPnl = activityPnl.get(asset);

    let apiPnl: number | null = null;
    let apiSource = "none";
    if (api) {
      apiPnl = api.pnl;
      apiSource = api.source;
    } else if (actPnl != null && activity.rows.some((r) => r.asset === asset)) {
      apiPnl = actPnl;
      apiSource = activity.truncated ? "activity_cashflow (truncated)" : "activity_cashflow";
    }

    const ledgerPnl = ledger?.ledgerRealizedPnl ?? 0;
    const diff =
      apiPnl != null ? ledgerPnl - apiPnl : null;

    let reason: string | null = null;
    if (diff != null && Math.abs(diff) > FLAG_THRESHOLD_USD) {
      if (!ledger || ledger.completedEpisodes === 0) {
        reason = "Ledger episode(s) not completed — realized_pnl null while API shows closed/realized PnL";
      } else if (ledger.exclusionSample) {
        reason = `Ledger exclusion: ${ledger.exclusionSample}`;
      } else if (apiSource.startsWith("activity")) {
        reason = "API from activity cashflow (not official realizedPnl); ledger uses indexed fills";
      } else if (ledger.lifecycleRows > 1) {
        reason = "Multiple lifecycle episodes / duplicate rows — ledger may under-count completion";
      } else if (activity.truncated) {
        reason = "Activity history truncated (~5.5k rows) — API side incomplete";
      } else {
        reason = "Fill/resolution mismatch vs Polymarket position accounting";
      }
    }

    rows.push({
      title:
        ledger?.title ??
        api?.title ??
        meta?.title ??
        asset.slice(0, 20) + "…",
      assetId: asset,
      ledgerBuy: ledger?.buyNotional ?? 0,
      ledgerSell: ledger?.sellNotional ?? 0,
      resolution: ledger?.resolutionOutcome ?? "—",
      ledgerPnl,
      apiPnl,
      apiSource,
      diff,
      reason,
    });
  }

  rows.sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));

  const flagged = rows.filter(
    (r) => r.diff != null && Math.abs(r.diff) > FLAG_THRESHOLD_USD
  );

  const ledgerNet = rows.reduce((s, r) => s + r.ledgerPnl, 0);
  const apiNetPositions = openPositions.reduce((s, p) => s + apiPositionPnl(p), 0);
  const apiNetClosed50 = closedPositions.reduce(
    (s, p) => s + Number(p.realizedPnl ?? 0),
    0
  );

  console.log(`\nMarkets / assets in union: ${rows.length}`);
  console.log(`Sum ledger realized (all assets): $${ledgerNet.toFixed(2)}`);
  console.log(
    `Sum API (open positions realized+cash on redeemable): $${apiNetPositions.toFixed(2)}`
  );
  console.log(
    `Sum API closed-positions (50-row cap only): $${apiNetClosed50.toFixed(2)}`
  );
  console.log(`Flagged |diff| > $${FLAG_THRESHOLD_USD}: ${flagged.length}`);

  console.log("\n--- All markets (CSV-style) ---");
  console.log(
    "title\tledger_buy\tledger_sell\tresolution\tledger_pnl\tapi_pnl\tapi_source\tdiff\tflag_reason"
  );
  for (const r of rows) {
    const flag =
      r.diff != null && Math.abs(r.diff) > FLAG_THRESHOLD_USD ? "FLAG" : "";
    console.log(
      [
        JSON.stringify(r.title.slice(0, 80)),
        r.ledgerBuy.toFixed(2),
        r.ledgerSell.toFixed(2),
        r.resolution,
        r.ledgerPnl.toFixed(2),
        r.apiPnl?.toFixed(2) ?? "",
        r.apiSource,
        r.diff?.toFixed(2) ?? "",
        flag ? r.reason ?? "" : "",
      ].join("\t")
    );
  }

  if (flagged.length > 0) {
    console.log("\n--- Top flagged (by |diff|) ---");
    for (const r of flagged.slice(0, 25)) {
      console.log(`\n${r.title}`);
      console.log(`  asset=${r.assetId.slice(0, 24)}…`);
      console.log(
        `  ledger buy=$${r.ledgerBuy.toFixed(2)} sell=$${r.ledgerSell.toFixed(2)} realized=$${r.ledgerPnl.toFixed(2)} | resolution=${r.resolution}`
      );
      console.log(
        `  API (${r.apiSource}) pnl=$${r.apiPnl?.toFixed(2)} | diff=$${r.diff?.toFixed(2)}`
      );
      console.log(`  Reason: ${r.reason}`);
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
