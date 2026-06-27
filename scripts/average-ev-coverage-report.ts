/**
 * Report Average EV source coverage with Kalshi-only vs +Manifold vs +Sportsbook lift.
 * Usage: npx tsx scripts/average-ev-coverage-report.ts [wallet...]
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function loadEnvLocal(): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvLocal();

import {
  computeTrackRecord,
  fetchClosedPositions,
  fetchWalletPositions,
  isEphemeralClosedPosition,
} from "../lib/polymarket";
import { computeClvStats } from "../lib/polymarket";
import { computeCrossMarketEvStats } from "../lib/crossMarketEvStats";
import {
  isClvAverageEvComputable,
  isCrossMarketEvComputable,
  resolveAverageEvDisplay,
} from "../lib/averageEvDisplay";
import { isSportsbookOddsEnabled } from "../lib/sportsbookOdds";

const TEST_WALLETS = [
  "0x22da1a1fc2b14f5c76b0e179048734c015ef2866",
  "0x0fce7c54120bfc84407035579f942a83290263d5",
  "0xe64bab48399e612bf7a585eacc9b2e9c2f31ce05",
  "0xe0dbdb7f005f233f4510e4ef7e53a2f76a8df44e",
  "0x5de61030c508fcff55514abb81ec5368713bd677",
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
];

type EvSource = "clv" | "cross_market" | "avg_return_fallback" | "unavailable";

type ProbeOptions = {
  includeManifold: boolean;
  includeSportsbook: boolean;
};

function summarizeSources(rows: Array<{ source: EvSource }>) {
  const total = rows.length;
  const realEv = rows.filter(
    (r) => r.source === "clv" || r.source === "cross_market"
  ).length;
  return {
    total,
    clv: rows.filter((r) => r.source === "clv").length,
    cross_market: rows.filter((r) => r.source === "cross_market").length,
    avg_return_fallback: rows.filter(
      (r) => r.source === "avg_return_fallback"
    ).length,
    unavailable: rows.filter((r) => r.source === "unavailable").length,
    realEvPct: total > 0 ? Math.round((realEv / total) * 1000) / 10 : 0,
    fallbackPct:
      total > 0
        ? Math.round(
            (rows.filter((r) => r.source === "avg_return_fallback").length /
              total) *
              1000
          ) / 10
        : 0,
  };
}

async function probeWallet(wallet: string, opts: ProbeOptions) {
  const [closedPositions, openPositions] = await Promise.all([
    fetchClosedPositions(wallet),
    fetchWalletPositions(wallet),
  ]);
  const eligible = closedPositions.filter(
    (p) => !isEphemeralClosedPosition(p)
  );
  const [clvStats, crossMarketEvStats] = await Promise.all([
    computeClvStats(eligible),
    computeCrossMarketEvStats(eligible, openPositions, {
      includeManifold: opts.includeManifold,
      includeSportsbook: opts.includeSportsbook,
    }),
  ]);

  const trackRecord = computeTrackRecord(closedPositions);

  const display = resolveAverageEvDisplay(clvStats, trackRecord, {
    crossMarketEvStats,
  });

  const validPositions = crossMarketEvStats.positions.filter((p) => p.valid);
  const validSlugs = validPositions.map((p) => p.slug);
  const kalshiMatches = validPositions.filter(
    (p) => p.fairSource === "kalshi"
  ).length;
  const manifoldMatches = validPositions.filter(
    (p) => p.fairSource === "manifold"
  ).length;
  const sportsbookMatches = validPositions.filter(
    (p) => p.fairSource === "sportsbook"
  ).length;

  /** Positions where sportsbook is the fair source (Kalshi/Manifold did not win priority). */
  const additiveSportsbookSlugs = validPositions
    .filter((p) => p.fairSource === "sportsbook")
    .map((p) => p.slug);

  return {
    wallet: `${wallet.slice(0, 8)}…${wallet.slice(-4)}`,
    source: display.mode as EvSource,
    label: display.label,
    value: display.value,
    badge: display.badge ?? null,
    clv: {
      ok: isClvAverageEvComputable(clvStats),
      coverage: `${clvStats.coverage}/${clvStats.totalClosed}`,
    },
    crossMarket: {
      ok: isCrossMarketEvComputable(crossMarketEvStats),
      coverage: `${crossMarketEvStats.coverage}/${crossMarketEvStats.totalEvaluated}`,
      kalshiMatches,
      manifoldMatches,
      sportsbookMatches,
      additiveSportsbookSlugs,
      validSlugs,
      avg: crossMarketEvStats.avgEv,
      fairSource: crossMarketEvStats.fairSource,
    },
  };
}

async function main() {
  const wallets =
    process.argv.length > 2
      ? process.argv.slice(2).filter((a) => !a.startsWith("--"))
      : TEST_WALLETS;

  const kalshiOnlyRows = [];
  const withManifoldRows = [];
  const fullStackRows = [];

  for (const wallet of wallets) {
    process.stderr.write(`Probing ${wallet.slice(0, 10)}…\n`);
    try {
      kalshiOnlyRows.push(
        await probeWallet(wallet, {
          includeManifold: false,
          includeSportsbook: false,
        })
      );
      withManifoldRows.push(
        await probeWallet(wallet, {
          includeManifold: true,
          includeSportsbook: false,
        })
      );
      fullStackRows.push(
        await probeWallet(wallet, {
          includeManifold: true,
          includeSportsbook: true,
        })
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const fail = { wallet: wallet.slice(0, 8), source: "unavailable", error };
      kalshiOnlyRows.push(fail as never);
      withManifoldRows.push(fail as never);
      fullStackRows.push(fail as never);
    }
  }

  const kalshiOnly = summarizeSources(kalshiOnlyRows);
  const withManifold = summarizeSources(withManifoldRows);
  const fullStack = summarizeSources(fullStackRows);

  const sportsbookAdditiveWallets = fullStackRows.filter(
    (r) =>
      "crossMarket" in r &&
      r.crossMarket.sportsbookMatches > 0
  );
  const walletsFlippedToCrossMarket = fullStackRows.filter((r, i) => {
    const prev = withManifoldRows[i];
    return (
      "source" in r &&
      "source" in prev &&
      prev.source !== "cross_market" &&
      r.source === "cross_market"
    );
  });

  const totalAdditiveSportsbookPositions = fullStackRows.reduce(
    (sum, r) =>
      sum +
      ("crossMarket" in r ? r.crossMarket.sportsbookMatches : 0),
    0
  );

  const positionLevelLift = fullStackRows.map((full, i) => {
    const base = withManifoldRows[i];
    if (!("crossMarket" in full) || !("crossMarket" in base)) {
      return { wallet: full.wallet, newValidSlugs: [], sportsbookOnlySlugs: [] };
    }
    const baseSlugs = new Set(base.crossMarket.validSlugs ?? []);
    const fullSlugs = full.crossMarket.validSlugs ?? [];
    const newValidSlugs = fullSlugs.filter((s) => !baseSlugs.has(s));
    return {
      wallet: full.wallet,
      newValidSlugs,
      sportsbookOnlySlugs: full.crossMarket.additiveSportsbookSlugs ?? [],
      baselineValid: baseSlugs.size,
      fullValid: fullSlugs.length,
    };
  });

  const totalNewValidPositions = positionLevelLift.reduce(
    (sum, r) => sum + r.newValidSlugs.length,
    0
  );

  console.log(
    JSON.stringify(
      {
        step: "Step 2 — The Odds API sportsbook consensus added",
        sportsbookEnabled: isSportsbookOddsEnabled(),
        kalshiOnly: {
          summary: kalshiOnly,
          wallets: kalshiOnlyRows,
        },
        withManifold: {
          summary: withManifold,
          wallets: withManifoldRows,
        },
        fullStack: {
          summary: fullStack,
          wallets: fullStackRows,
        },
        lift: {
          realEvPct: {
            kalshiOnly: `${kalshiOnly.realEvPct}%`,
            withManifold: `${withManifold.realEvPct}%`,
            fullStack: `${fullStack.realEvPct}%`,
            manifoldDelta: `${withManifold.realEvPct - kalshiOnly.realEvPct}pp`,
            sportsbookDelta: `${fullStack.realEvPct - withManifold.realEvPct}pp`,
          },
          crossMarketWallets: {
            kalshiOnly: kalshiOnly.cross_market,
            withManifold: withManifold.cross_market,
            fullStack: fullStack.cross_market,
          },
          fallbackWallets: {
            kalshiOnly: kalshiOnly.avg_return_fallback,
            withManifold: withManifold.avg_return_fallback,
            fullStack: fullStack.avg_return_fallback,
          },
          sportsbook: {
            totalSportsbookFairSourcePositions:
              totalAdditiveSportsbookPositions,
            totalNewValidPositions,
            positionLevelLift,
            walletsUsingSportsbook: sportsbookAdditiveWallets.length,
            walletsFlippedToCrossMarketBySportsbook:
              walletsFlippedToCrossMarket.length,
            additiveOnly:
              "Positions where sportsbook wins priority (Kalshi/Manifold absent or not quotable)",
          },
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
