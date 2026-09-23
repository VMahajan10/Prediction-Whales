#!/usr/bin/env tsx
/**
 * Read-only Product Feed Option 1 acceptance harness.
 * Uses production qualification modules; no writes, no deploy.
 */
import "../tests/preload-env";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import {
  MIN_PRODUCT_FEED_STAKE_USD,
  MIN_FEED_TRADE_EV_PCT,
  meetsProductFeedStakeThreshold,
  meetsFeedTradeEvThreshold,
  isQualifiedTraderForProductFeed,
  passesPolymarketFeedTraderGate,
  resolveProductFeedWalletBlockReason,
  resolveTraderResolvedVolumeUsd,
} from "@/lib/feedQualification";
import { qualifyWalletsForFeed } from "@/lib/feedQualificationServer";
import {
  coerceFiniteResolvedVolumeUsd,
  resolveProductFeedHistoricalVolumeFromIndexedRow,
} from "@/lib/feed/productFeedHistoricalVolume";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { evaluatePostQueueCredibilityGate } from "@/lib/x-agent/postQueueGates";

const LOOKBACK_DAYS = 30;

const THREE_WALLETS = [
  "0x2c335066fe58fe9237c3d3dc7b275c2a034a0563",
  "0xa0f21e6d351baa9185716b5c00c2925ed9621848",
  "0x44c58184f89a5c2f699dc8943009cb3d75a08d45",
];

const PROXY_FALSE_FAIL_WALLETS = [
  "0x1b47e9b128e6b671edebfb2cac23dd3efc40d814",
  "0xdc41c39b95453c943174f369926018f6963bdd7e",
];

type Failure = { section: string; detail: string };
const failures: Failure[] = [];
const unexpectedMismatches: Failure[] = [];

const sectionStatus: Record<string, boolean> = {
  tradeRules: true,
  hydrationRule: true,
  completedPositionsRule: true,
  authoritativeVolumeRule: true,
  failClosed: true,
  oldFallbackRemoved: true,
  walletAvgEvRemoved: true,
  xAgentUnchanged: true,
  batchVolumeQuery: true,
  replay30Day: true,
};

const SECTION_KEY_MAP: Record<string, string> = {
  tradeRules: "tradeRules",
  hydrationRule: "hydrationRule",
  completedPositionsRule: "completedPositionsRule",
  authoritativeVolumeRule: "authoritativeVolumeRule",
  failClosed: "failClosed",
  oldFallbackRemoved: "oldFallbackRemoved",
  walletAvgEvRemoved: "walletAvgEvRemoved",
  xAgentUnchanged: "xAgentUnchanged",
  batchVolumeQuery: "batchVolumeQuery",
  threeWallets: "authoritativeVolumeRule",
  proxyFalseFail: "oldFallbackRemoved",
  setup: "replay30Day",
};

function fail(section: string, detail: string): void {
  failures.push({ section, detail });
  const key = SECTION_KEY_MAP[section] ?? section;
  if (key in sectionStatus) {
    sectionStatus[key] = false;
  }
}

/** OLD gate reference — comparison only, not Option 1 qualification. */
function oldProductionWalletGatePass(wr: {
  hydration_status: string;
  resolved_bets_count: number;
  avg_stake_notional: number;
  avg_ev: number;
}): boolean {
  if (wr.hydration_status !== "complete") return false;
  if (wr.resolved_bets_count < 10) return false;
  if (wr.avg_ev < 0.03) return false;
  const proxy =
    wr.avg_stake_notional > 0 && wr.resolved_bets_count > 0
      ? wr.resolved_bets_count * wr.avg_stake_notional
      : 0;
  return proxy >= 300;
}

function tradeLevelPass(stake: number, ev: number): boolean {
  return (
    meetsProductFeedStakeThreshold(stake) &&
    meetsFeedTradeEvThreshold(ev)
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail("setup", "DATABASE_URL not configured");
    printReport({});
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    // --- Static implementation guards (section 7) ---
    const qualSource = readFileSync(
      resolve("lib/feedQualification.ts"),
      "utf8"
    );
    const traderFnMatch = qualSource.match(
      /export function isQualifiedTraderForProductFeed\([\s\S]*?\n\}/
    );
    const traderFnBody = traderFnMatch?.[0] ?? "";
    if (traderFnBody.includes("meetsWalletAvgEvThreshold")) {
      fail(
        "walletAvgEvRemoved",
        "isQualifiedTraderForProductFeed still references meetsWalletAvgEvThreshold"
      );
    }

    const serverSource = readFileSync(
      resolve("lib/feedQualificationServer.ts"),
      "utf8"
    );
    if (serverSource.includes("resolveTraderResolvedVolumeUsd")) {
      fail(
        "oldFallbackRemoved",
        "feedQualificationServer still calls resolveTraderResolvedVolumeUsd"
      );
    }

    // --- Fixture assertions D–J (production resolvers) ---
    runFixtureAssertions();

    // --- 30-day cohort ---
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const tradeRows = await client.query<{
      trade_id: string;
      proxy_wallet: string;
      stake_amount: number;
      average_ev: number;
    }>(
      `
      SELECT trade_id, lower(proxy_wallet) AS proxy_wallet, stake_amount, average_ev
      FROM feed_trades
      WHERE traded_at >= $1
        AND proxy_wallet IS NOT NULL
        AND trim(proxy_wallet) <> ''
    `,
      [since]
    );

    const cohortTradeLevel = tradeRows.rows.filter((r) =>
      tradeLevelPass(r.stake_amount, r.average_ev)
    );

    for (const row of tradeRows.rows) {
      if (row.stake_amount < MIN_PRODUCT_FEED_STAKE_USD && tradeLevelPass(row.stake_amount, row.average_ev)) {
        fail("tradeRules", `stake < 500 marked trade-eligible: ${row.trade_id}`);
      }
      if (
        row.average_ev < MIN_FEED_TRADE_EV_PCT &&
        tradeLevelPass(row.stake_amount, row.average_ev)
      ) {
        fail("tradeRules", `EV < 3% marked trade-eligible: ${row.trade_id}`);
      }
    }

    const wallets = [
      ...new Set(cohortTradeLevel.map((r) => r.proxy_wallet.toLowerCase())),
    ];

    const qualifications = await qualifyWalletsForFeed(wallets);

    const wrRows = await client.query<{
      w: string;
      hydration_status: string;
      resolved_bets_count: number;
      avg_stake_notional: number;
      avg_ev: number;
    }>(
      `
      SELECT lower(wallet_address) AS w, hydration_status, resolved_bets_count,
             avg_stake_notional, avg_ev
      FROM whale_registry
      WHERE lower(wallet_address) = ANY($1::text[])
    `,
      [wallets]
    );
    const wrMap = new Map(wrRows.rows.map((r) => [r.w, r]));

    const metricsRows = await client.query<{
      w: string;
      metric_version: string;
      credibility_metrics_valid: boolean;
      resolved_volume_usd: number | null;
    }>(
      `
      SELECT lower(wallet_address) AS w, metric_version, credibility_metrics_valid, resolved_volume_usd
      FROM wallet_historical_metrics
      WHERE lower(wallet_address) = ANY($1::text[])
    `,
      [wallets]
    );
    const metricsByWallet = new Map<string, typeof metricsRows.rows>();
    for (const row of metricsRows.rows) {
      const list = metricsByWallet.get(row.w) ?? [];
      list.push(row);
      metricsByWallet.set(row.w, list);
    }

    type WalletReport = {
      wallet: string;
      hydrationStatus: string | null;
      resolvedBetsCount: number | null;
      avgStakeNotional: number | null;
      walletAvgEv: number | null;
      historicalMetricsRowPresent: boolean;
      metricVersionMatches: boolean;
      credibilityMetricsValid: boolean | null;
      authoritativeResolvedVolumeUsd: number | null;
      historicalVolumeTrusted: boolean;
      historicalVolumeReason: string | null;
      productFeedWalletBlockReason: string | null;
      oldGatePass: boolean;
      option1Pass: boolean;
      tradeCount: number;
      stakeUsd: number;
    };

    const walletStats = new Map<
      string,
      { tradeCount: number; stakeUsd: number }
    >();
    for (const row of cohortTradeLevel) {
      const w = row.proxy_wallet.toLowerCase();
      const s = walletStats.get(w) ?? { tradeCount: 0, stakeUsd: 0 };
      s.tradeCount += 1;
      s.stakeUsd += row.stake_amount;
      walletStats.set(w, s);
    }

    const walletReports: WalletReport[] = [];

    for (const wallet of wallets) {
      const wr = wrMap.get(wallet);
      const qual = qualifications[wallet];
      const metricRows = metricsByWallet.get(wallet) ?? [];
      const versionRow = metricRows.find(
        (m) => m.metric_version === WALLET_METRIC_VERSION
      );

      const oldPass = wr ? oldProductionWalletGatePass(wr) : false;
      const option1WalletPass = qual?.qualified === true;
      const stats = walletStats.get(wallet) ?? { tradeCount: 0, stakeUsd: 0 };

      const report: WalletReport = {
        wallet,
        hydrationStatus: wr?.hydration_status ?? qual?.hydrationState ?? null,
        resolvedBetsCount: qual?.resolvedBetsCount ?? wr?.resolved_bets_count ?? null,
        avgStakeNotional: qual?.avgStakeNotional ?? wr?.avg_stake_notional ?? null,
        walletAvgEv: qual?.avgEv ?? wr?.avg_ev ?? null,
        historicalMetricsRowPresent: metricRows.length > 0,
        metricVersionMatches: versionRow != null,
        credibilityMetricsValid: versionRow?.credibility_metrics_valid ?? null,
        authoritativeResolvedVolumeUsd: qual?.historicalVolumeUsd ?? null,
        historicalVolumeTrusted: qual?.historicalVolumeTrusted ?? false,
        historicalVolumeReason: qual?.historicalVolumeReason ?? null,
        productFeedWalletBlockReason: qual?.productFeedWalletBlockReason ?? null,
        oldGatePass: oldPass,
        option1Pass: option1WalletPass,
        tradeCount: stats.tradeCount,
        stakeUsd: Math.round(stats.stakeUsd * 100) / 100,
      };
      walletReports.push(report);

      // Spec consistency: qualification vs block reason
      const expectedBlock = qual
        ? qual.qualified
          ? null
          : resolveProductFeedWalletBlockReason({
              walletInRegistry: wr != null,
              hydrationState: qual.hydrationState,
              resolvedBetsCount: qual.resolvedBetsCount,
              resolvedVolumeUSD: qual.resolvedVolumeUSD,
              historicalResolvedVolumeTrusted:
                qual.historicalResolvedVolumeTrusted,
              historicalVolumeGateReason: qual.historicalVolumeGateReason,
            })
        : "wallet_not_in_registry";

      if (qual && qual.productFeedWalletBlockReason !== expectedBlock) {
        unexpectedMismatches.push({
          section: "blockReason",
          detail: `${wallet}: reported=${qual.productFeedWalletBlockReason} expected=${expectedBlock}`,
        });
      }

      if (wr && wr.hydration_status !== "complete" && option1WalletPass) {
        fail("hydrationRule", `${wallet} passed with hydration !== complete`);
      }

      if (
        wr &&
        wr.resolved_bets_count < 10 &&
        option1WalletPass
      ) {
        fail(
          "completedPositionsRule",
          `${wallet} passed with resolved_bets_count < 10`
        );
      }

      if (!versionRow && option1WalletPass) {
        fail(
          "authoritativeVolumeRule",
          `${wallet} passed without WALLET_METRIC_VERSION metrics row`
        );
      }

      if (
        versionRow &&
        !versionRow.credibility_metrics_valid &&
        option1WalletPass
      ) {
        fail(
          "failClosed",
          `${wallet} passed with credibility_metrics_valid=false`
        );
      }

      if (option1WalletPass && qual) {
        const proxy = resolveTraderResolvedVolumeUsd({
          resolvedBetsCount: qual.resolvedBetsCount,
          avgStakeNotional: qual.avgStakeNotional,
        });
        if (
          proxy >= 300 &&
          (qual.historicalVolumeUsd ?? 0) < 300
        ) {
          fail(
            "oldFallbackRemoved",
            `${wallet} passed on proxy despite authoritative < 300`
          );
        }
      }
    }

    console.error(
      JSON.stringify({ walletDecisions: walletReports }, null, 2)
    );

    // Trade-level assertions on full cohort
    for (const row of tradeRows.rows) {
      const w = row.proxy_wallet.toLowerCase();
      const qual = qualifications[w];
      const tradeOk = tradeLevelPass(row.stake_amount, row.average_ev);
      const option1TradeVisible =
        tradeOk && qual != null && passesPolymarketFeedTraderGate(w, qual);

      if (row.stake_amount < MIN_PRODUCT_FEED_STAKE_USD && option1TradeVisible) {
        fail("tradeRules", `visible trade below stake floor: ${row.trade_id}`);
      }
      if (row.average_ev < MIN_FEED_TRADE_EV_PCT && option1TradeVisible) {
        fail("tradeRules", `visible trade below EV floor: ${row.trade_id}`);
      }
    }

    // Three-wallet verification
    for (const wallet of THREE_WALLETS) {
      const w = wallet.toLowerCase();
      const wr = wrMap.get(w);
      const qual = qualifications[w];
      const versionRow = (metricsByWallet.get(w) ?? []).find(
        (m) => m.metric_version === WALLET_METRIC_VERSION
      );
      const oldPass = wr ? oldProductionWalletGatePass(wr) : false;
      const option1Pass = qual?.qualified === true;

      if (!oldPass) {
        unexpectedMismatches.push({
          section: "threeWallets",
          detail: `${w}: expected old gate PASS, got FAIL`,
        });
      }
      if (option1Pass) {
        fail("threeWallets", `${w}: expected Option 1 FAIL, got PASS`);
      }
      const block = qual?.productFeedWalletBlockReason;
      if (versionRow) {
        fail(
          "threeWallets",
          `${w}: expected no WALLET_METRIC_VERSION row but row exists`
        );
      } else if (block !== "historical_volume_unavailable") {
        fail(
          "threeWallets",
          `${w}: block reason=${block}, expected historical_volume_unavailable only`
        );
      }
    }

    // Proxy false-fail wallets
    for (const wallet of PROXY_FALSE_FAIL_WALLETS) {
      const w = wallet.toLowerCase();
      const wr = wrMap.get(w);
      const qual = qualifications[w];
      if (!wr || !qual) continue;
      const proxy =
        wr.avg_stake_notional > 0
          ? wr.resolved_bets_count * wr.avg_stake_notional
          : 0;
      const auth = qual.historicalVolumeUsd;
      console.error(
        JSON.stringify({
          proxyFalseFailWallet: w,
          proxyVolume: proxy,
          authoritativeResolvedVolumeUsd: auth,
          oldGatePass: oldProductionWalletGatePass(wr),
          option1Pass: qual.qualified,
          historicalVolumeTrusted: qual.historicalVolumeTrusted,
        })
      );
      if (proxy < 300 && auth != null && auth >= 300 && qual.historicalVolumeTrusted) {
        if (!qual.qualified) {
          fail(
            "proxyFalseFail",
            `${w}: authoritative >= 300 but Option 1 wallet gate failed`
          );
        }
      }
    }

    // K: low avg_ev wallet that passes Option 1 in cohort
    const lowEvPass = walletReports.find(
      (r) =>
        r.option1Pass &&
        r.walletAvgEv != null &&
        r.walletAvgEv < 0 &&
        (r.resolvedBetsCount ?? 0) >= 10 &&
        r.historicalVolumeTrusted
    );
    if (lowEvPass) {
      if (lowEvPass.productFeedWalletBlockReason != null) {
        fail(
          "walletAvgEvRemoved",
          `${lowEvPass.wallet}: block reason should be null`
        );
      }
    } else {
      // Synthetic K via production functions
      const syntheticPass = isQualifiedTraderForProductFeed({
        resolvedBetsCount: 10,
        avgEv: -0.5,
        avgStakeNotional: 0,
        resolvedVolumeUSD: 500,
        historicalResolvedVolumeTrusted: true,
      });
      if (!syntheticPass) {
        fail("walletAvgEvRemoved", "synthetic low avg_ev trader gate failed");
      }
    }

    // L: X-agent unchanged
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const xResult = evaluatePostQueueCredibilityGate({
        tradeId: "acceptance-low-ev",
        stakeNotional: 600,
        walletAddress: "0xacceptance",
        walletAvgEv: -0.5,
        resolvedBetCount: 10,
        whale: {
          resolvedBetsCount: 10,
          avgEv: -0.5,
          winRate: 0.4,
          avgStakeNotional: 50,
        },
      });
      if (xResult.passed) {
        fail("xAgentUnchanged", "post-queue gate passed negative wallet avg_ev");
      }
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // M: batch volume query (vitest subprocess — production test)
    const vitest = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "tests/feedQualificationServer.test.ts",
        "-t",
        "fetches authoritative volume exactly once",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    if (vitest.status !== 0) {
      fail(
        "batchVolumeQuery",
        `vitest batch query test failed: ${vitest.stderr?.slice(0, 500)}`
      );
    }

    sectionStatus.replay30Day = true;

    // Side-by-side impact
    let oldVisible = 0;
    let newVisible = 0;
    let oldStake = 0;
    let newStake = 0;
    const oldWallets = new Set<string>();
    const newWallets = new Set<string>();
    let addedTrades = 0;
    let removedTrades = 0;
    let addedStake = 0;
    let removedStake = 0;

    const removalReasons: Record<string, number> = {};
    const additionReasons: Record<string, number> = {};

    for (const row of cohortTradeLevel) {
      const w = row.proxy_wallet.toLowerCase();
      const wr = wrMap.get(w);
      const qual = qualifications[w];
      const oldOk = wr != null && oldProductionWalletGatePass(wr);
      const newOk =
        qual != null && passesPolymarketFeedTraderGate(w, qual);

      if (oldOk) {
        oldVisible += 1;
        oldStake += row.stake_amount;
        oldWallets.add(w);
      }
      if (newOk) {
        newVisible += 1;
        newStake += row.stake_amount;
        newWallets.add(w);
      }

      if (newOk && !oldOk) {
        addedTrades += 1;
        addedStake += row.stake_amount;
        if (wr && wr.avg_ev < 0.03) {
          additionReasons.wallet_avg_ev_gate_removed =
            (additionReasons.wallet_avg_ev_gate_removed ?? 0) + 1;
        } else if (wr) {
          const proxy =
            wr.avg_stake_notional > 0
              ? wr.resolved_bets_count * wr.avg_stake_notional
              : 0;
          if (proxy < 300 && (qual?.historicalVolumeUsd ?? 0) >= 300) {
            additionReasons.old_proxy_volume_false_fail_removed =
              (additionReasons.old_proxy_volume_false_fail_removed ?? 0) + 1;
          } else {
            additionReasons.other = (additionReasons.other ?? 0) + 1;
          }
        }
      }

      if (oldOk && !newOk) {
        removedTrades += 1;
        removedStake += row.stake_amount;
        const reason = qual?.productFeedWalletBlockReason ?? "other";
        removalReasons[reason] = (removalReasons[reason] ?? 0) + 1;
      }
    }

    const impact = {
      oldGate: {
        visibleTrades: oldVisible,
        stakeUsd: Math.round(oldStake * 100) / 100,
        uniqueWallets: oldWallets.size,
      },
      option1: {
        visibleTrades: newVisible,
        stakeUsd: Math.round(newStake * 100) / 100,
        uniqueWallets: newWallets.size,
      },
      diff: {
        addedTrades,
        addedStakeUsd: Math.round(addedStake * 100) / 100,
        removedTrades,
        removedStakeUsd: Math.round(removedStake * 100) / 100,
        removalReasons,
        additionReasons,
      },
    };

    printReport({
      sectionStatus,
      impact,
      unexpectedMismatches,
      cohortTradeLevelCount: cohortTradeLevel.length,
    });
  } finally {
    client.release();
    await pool.end();
  }

  process.exit(failures.length > 0 || unexpectedMismatches.length > 0 ? 1 : 0);
}

function runFixtureAssertions(): void {
  const assertResolution = (
    label: string,
    resolution: ReturnType<typeof resolveProductFeedHistoricalVolumeFromIndexedRow>,
    expectedReason: string | null,
    expectedTrusted: boolean
  ) => {
    if (resolution.historicalVolumeGateReason !== expectedReason) {
      fail(
        "authoritativeVolumeRule",
        `${label}: reason=${resolution.historicalVolumeGateReason} expected=${expectedReason}`
      );
    }
    if (resolution.historicalResolvedVolumeTrusted !== expectedTrusted) {
      fail("failClosed", `${label}: trusted=${resolution.historicalResolvedVolumeTrusted}`);
    }
  };

  assertResolution(
    "D-null",
    resolveProductFeedHistoricalVolumeFromIndexedRow(null),
    "historical_volume_unavailable",
    false
  );

  assertResolution(
    "E-invalid-cred",
    resolveProductFeedHistoricalVolumeFromIndexedRow({
      credibilityMetricsValid: false,
      resolvedVolumeUsd: 50_000,
    }),
    "historical_volume_unavailable",
    false
  );

  assertResolution(
    "F-nan",
    resolveProductFeedHistoricalVolumeFromIndexedRow({
      credibilityMetricsValid: true,
      resolvedVolumeUsd: Number.NaN,
    }),
    "historical_volume_unavailable",
    false
  );

  assertResolution(
    "G-299.99",
    resolveProductFeedHistoricalVolumeFromIndexedRow({
      credibilityMetricsValid: true,
      resolvedVolumeUsd: 299.99,
    }),
    "historical_volume_below_minimum",
    false
  );

  const h = resolveProductFeedHistoricalVolumeFromIndexedRow({
    credibilityMetricsValid: true,
    resolvedVolumeUsd: 300,
  });
  if (h.status !== "trusted" || !h.historicalResolvedVolumeTrusted) {
    fail("authoritativeVolumeRule", "H: volume 300 should pass");
  }

  // I: proxy would pass, authoritative fails
  const iPass = isQualifiedTraderForProductFeed({
    resolvedBetsCount: 10,
    avgStakeNotional: 50,
    historicalResolvedVolumeTrusted: false,
    historicalVolumeGateReason: "historical_volume_below_minimum",
    resolvedVolumeUSD: 250,
  });
  if (iPass) {
    fail("oldFallbackRemoved", "I: should fail when authoritative < 300");
  }

  // J: proxy fails, authoritative passes
  const jPass = isQualifiedTraderForProductFeed({
    resolvedBetsCount: 10,
    avgStakeNotional: 1,
    resolvedVolumeUSD: 500,
    historicalResolvedVolumeTrusted: true,
  });
  if (!jPass) {
    fail("authoritativeVolumeRule", "J: authoritative >= 300 should pass");
  }

  if (coerceFiniteResolvedVolumeUsd("not-a-number") != null) {
    fail("failClosed", "non-numeric string coerced to volume");
  }
}

function printReport(ctx: {
  sectionStatus?: Record<string, boolean>;
  impact?: Record<string, unknown>;
  unexpectedMismatches?: Failure[];
  cohortTradeLevelCount?: number;
}): void {
  const status =
    failures.length === 0 && (ctx.unexpectedMismatches?.length ?? 0) === 0
      ? "PASS"
      : "FAIL";

  console.log(`OPTION1_ACCEPTANCE_STATUS:\n${status}\n`);
  console.log(`Trade rules:\n${boolLine(ctx.sectionStatus?.tradeRules)}\n`);
  console.log(`Hydration rule:\n${boolLine(ctx.sectionStatus?.hydrationRule)}\n`);
  console.log(
    `Completed positions rule:\n${boolLine(ctx.sectionStatus?.completedPositionsRule)}\n`
  );
  console.log(
    `Authoritative volume rule:\n${boolLine(ctx.sectionStatus?.authoritativeVolumeRule)}\n`
  );
  console.log(`Fail-closed behavior:\n${boolLine(ctx.sectionStatus?.failClosed)}\n`);
  console.log(
    `Old volume fallback removed:\n${boolLine(ctx.sectionStatus?.oldFallbackRemoved)}\n`
  );
  console.log(
    `Wallet avg_ev removed from product feed:\n${boolLine(ctx.sectionStatus?.walletAvgEvRemoved)}\n`
  );
  console.log(`X-agent unchanged:\n${boolLine(ctx.sectionStatus?.xAgentUnchanged)}\n`);
  console.log(`Batch volume query:\n${boolLine(ctx.sectionStatus?.batchVolumeQuery)}\n`);

  if (ctx.impact) {
    console.log(`30-day replay:\n${JSON.stringify(ctx.impact, null, 2)}\n`);
  } else if (ctx.cohortTradeLevelCount != null) {
    console.log(
      `30-day replay:\n(trade-level cohort rows: ${ctx.cohortTradeLevelCount})\n`
    );
  } else {
    console.log(`30-day replay:\n[not run]\n`);
  }

  const mismatchCount =
    (ctx.unexpectedMismatches?.length ?? 0) + failures.length;
  console.log(`Unexpected mismatches:\n${mismatchCount}`);
  for (const f of failures) {
    console.log(`  [${f.section}] ${f.detail}`);
  }
  for (const m of ctx.unexpectedMismatches ?? []) {
    console.log(`  [${m.section}] ${m.detail}`);
  }
  console.log(`\nDEPLOYMENT_STATUS:\nNOT_DEPLOYED`);
}

function boolLine(ok?: boolean): string {
  if (ok === undefined) return "FAIL";
  return ok ? "PASS" : "FAIL";
}

void main().catch((error) => {
  console.error(error);
  printReport({});
  process.exit(1);
});
