import type {
  BacktestWindowConfig,
  ClvPanelStats,
  TradeClvRecord,
  WalletFunnelRow,
} from "@/lib/backtest/types";
import type { WalletClvAggregate } from "@/lib/backtest/clvTrade";

export function formatClvCents(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}¢`;
}

export function buildClvMarkdownReport(input: {
  config: BacktestWindowConfig;
  stats: ClvPanelStats;
  walletFunnel: WalletFunnelRow[];
  rankedWeighted: WalletClvAggregate[];
  rankedUnweighted: WalletClvAggregate[];
  verificationSamples: TradeClvRecord[];
}): string {
  const { config, stats, walletFunnel, rankedWeighted, rankedUnweighted } =
    input;
  const validPct =
    stats.fillsExtracted > 0
      ? ((stats.validClvFills / stats.fillsExtracted) * 100).toFixed(1)
      : "0.0";
  const preClosePct =
    stats.fillsExtracted > 0
      ? ((stats.preCloseExcluded / stats.fillsExtracted) * 100).toFixed(1)
      : "0.0";

  const walletsWithZero =
    walletFunnel.filter((w) => w.ledgerBuyRowsInWindow === 0).length;
  const walletsWithFills = walletFunnel.filter((w) => w.parsedFills > 0).length;

  const funnelTable = walletFunnel
    .filter((w) => w.ledgerBuyRowsInWindow > 0 || w.parsedFills > 0)
    .slice(0, 40)
    .map(
      (w) =>
        `| ${w.walletAddress.slice(0, 12)}… | ${w.ledgerBuyRowsInWindow} | ${w.ledgerBuyRowsExtractable} | ${w.parsedFills} | ${w.afterMarketFilters} | ${w.validClv} | ${w.topExclusionReason ?? "—"} |`
    )
    .join("\n");

  const topWeighted = rankedWeighted
    .slice(0, 10)
    .map(
      (r, i) =>
        `${i + 1}. \`${r.walletAddress}\` — wCLV ${formatClvCents(r.weightedClvCents)} (${r.validClvTrades}/${r.qualifyingTrades} valid)`
    )
    .join("\n");

  const topUnweighted = rankedUnweighted
    .slice(0, 10)
    .map(
      (r, i) =>
        `${i + 1}. \`${r.walletAddress}\` — uCLV ${formatClvCents(r.unweightedClvCents)} (${r.validClvTrades}/${r.qualifyingTrades} valid)`
    )
    .join("\n");

  const verifyBlock = input.verificationSamples
    .map((t, i) => {
      const entryCents = Math.round(t.price * 1000) / 10;
      const closeCents =
        t.closingLinePrice != null
          ? Math.round(t.closingLinePrice * 1000) / 10
          : null;
      return `### Sample ${i + 1}
- **Market:** ${t.marketTitle ?? "—"} (\`${t.marketId}\`)
- **Outcome:** ${t.outcome ?? "—"} (token \`${t.tokenId}\`)
- **Entry:** ${entryCents}¢ @ ${new Date(t.timestamp * 1000).toISOString()}
- **Close:** ${closeCents != null ? `${closeCents}¢` : "—"} @ ${t.closeTimestamp != null ? new Date(t.closeTimestamp * 1000).toISOString() : "—"}
- **CLV:** ${formatClvCents(t.clvCents)}`;
    })
    .join("\n\n");

  return `# CLV panel report

- **Window:** ${config.rankStart} → ${config.rankEnd}
- **Generated:** ${new Date().toISOString()}
- **Hydrated wallets:** ${stats.hydratedWalletCount}
- **Wallets with ≥1 ledger BUY in window:** ${stats.walletsWithAnyLedgerBuyInWindow} (${walletsWithZero} hydrated wallets had 0 rows)
- **Wallets with parsed fills:** ${walletsWithFills}

## Fill funnel

| Step | Count |
|------|------:|
| Ledger BUY rows (all) | ${stats.ledgerBuyRowsInWindow} |
| Ledger BUY rows (extractable) | ${stats.ledgerBuyRowsExtractable} |
| Extracted fills | ${stats.fillsExtracted} |
| After market filters | ${stats.fillsAfterMarketFilters} |
| Valid CLV | ${stats.validClvFills} (${validPct}%) |
| Pre-close excluded | ${stats.preCloseExcluded} (${preClosePct}%) |
| Missing closing price | ${stats.missingClosingPrice} |
| Closing-line leakage share (close &lt;5¢ or &gt;95¢) | ${(stats.closingLineLeakageShare * 100).toFixed(1)}% |
| Fill source | ${stats.fillSource} |
| Data API extractable rate (this run) | ${stats.dataApiExtractableRate != null ? `${(stats.dataApiExtractableRate * 100).toFixed(1)}%` : "—"} |
| Unresolved / disputed | ${stats.unresolvedMarketExcluded} |

## Per-wallet funnel (top 40 by ledger rows)

| Wallet | Ledger BUYs | Extractable | Parsed | After filters | Valid CLV | Top exclusion |
|--------|------------:|------------:|-------:|--------------:|----------:|---------------|
${funnelTable || "| — | — | — | — | — | — | — |"}

## Top 10 — size-weighted CLV (min ${config.minTradesPerWallet} trades)

${topWeighted || "_None_"}

## Top 10 — unweighted CLV

${topUnweighted || "_None_"}

## Manual verification samples (5 random valid CLV trades)

${verifyBlock || "_No valid CLV trades to sample._"}
`;
}
