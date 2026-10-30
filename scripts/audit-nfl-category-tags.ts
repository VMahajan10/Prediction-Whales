#!/usr/bin/env tsx
/**
 * Spot-check NFL-tagged positions (gamma title + inferCategoryBadge).
 */
import "../tests/preload-env";
import { inferCategoryBadge } from "@/lib/marketCategory";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";
import { loadCachedClosedPositions } from "@/lib/polymarketDataApi/positionsStore";

const WALLET = process.argv[2]?.toLowerCase();

function titleLooksLikeNfl(title: string): boolean {
  return /\bnfl\b|super bowl|touchdown|nfl\s+week|spread:|o\/u\s*\d/i.test(
    title
  );
}

async function main() {
  const wallet =
    WALLET ?? "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
  const stats = await resolveWalletProfitFactorStats(wallet);
  const rows = await loadCachedClosedPositions(wallet);
  const positions = rows.map((r) => ({
    realizedPnl: r.realizedPnl,
    title: r.title ?? undefined,
    categoryLabel: r.categoryLabel ?? undefined,
    hasReliableTitle: Boolean(r.title?.trim()),
    hasReliableCategory: Boolean(r.categoryLabel?.trim()),
  }));

  const nflSlice = stats.byCategoryLabel.find((s) => s.categoryLabel === "NFL");
  console.log(
    `Wallet ${wallet}\nNFL slice: ${nflSlice?.positionCount ?? 0} positions | ledger overall PF ${stats.overall?.profitFactor?.toFixed(2) ?? "n/a"}\n`
  );

  const nflSamples = positions.filter(
    (p) =>
      p.hasReliableTitle &&
      p.title &&
      inferCategoryBadge(p.title).label === "NFL"
  );

  const sample = nflSamples.slice(0, 10);
  if (sample.length === 0) {
    console.log(
      "No NFL-tagged positions with gamma titles in this wallet (may need more gamma lookups or wallet has no NFL)."
    );
    return;
  }

  console.log(`First ${sample.length} NFL-tagged positions:\n`);
  for (const [i, s] of sample.entries()) {
    const title = s.title!;
    const ok = titleLooksLikeNfl(title);
    console.log(
      `${i + 1}. [${ok ? "OK" : "REVIEW"}] ${title.slice(0, 110)}`
    );
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
