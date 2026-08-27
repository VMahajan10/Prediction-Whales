import type { OnChainAuditWalletResult } from "@/lib/walletLedger/onchain/types";
import type { FeasibilityEstimate } from "@/lib/walletLedger/onchain/types";

function iso(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "N/A";
  return new Date(ts * 1000).toISOString();
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

function metricsBlock(
  label: string,
  m: OnChainAuditWalletResult["combinedLedgerMetrics"] | null
): string {
  if (!m) return `### ${label}\n\nNo metrics (empty ledger).\n`;
  return `### ${label}

| Metric | Value |
|--------|-------|
| Distinct positions | ${m.distinctPositionCount ?? "—"} |
| Completed positions | ${m.completedPositionCount} |
| Fully exited | ${m.fullyExitedPositionCount} |
| Held through resolution | ${m.heldThroughResolutionPositionCount} |
| Open | ${m.openPositionCount} |
| MERGE/SPLIT ambiguous | ${m.mergeSplit.ambiguousMergeSplit} |
| Capital at risk (median) | $${(m.medianCapitalAtRisk ?? 0).toFixed(0)} |
| Realized PnL | $${(m.totalRealizedPnl ?? 0).toFixed(2)} |
| Portfolio ROI | ${pct(m.portfolioRealizedRoi)} |
| Profitable rate | ${pct(m.profitablePositionRate)} |
| Resolved volume | $${(m.resolvedVolumeUsd ?? 0).toFixed(0)} |
| historyComplete | ${m.historyComplete} |
| historyValidity | ${m.historyValidity} |
| credibilityMetricsValid | ${m.credibilityMetricsValid} |
`;
}

export function formatPhase2cMarkdownReport(input: {
  results: OnChainAuditWalletResult[];
  feasibility: FeasibilityEstimate[];
}): string {
  const lines: string[] = [
    "# Phase 2C On-Chain History Fallback — Diagnostic Report",
    "",
    "## On-chain architecture",
    "",
    "```",
    "CTF Exchange v1 / Neg Risk / v2",
    "  → OrderFilled (maker/taker, asset amounts)",
    "Conditional Tokens (Gnosis CTF ERC-1155)",
    "  → TransferSingle/Batch, PositionSplit, PositionsMerge,",
    "    PayoutRedemption, ConditionResolution",
    "decode.ts (ABI-aligned topic parsers)",
    "  → normalize.ts (WalletLedgerEvent source=polygon)",
    "  → buildPositionLifecycles / computeWalletLedgerMetrics",
    "Resolution: on-chain ConditionResolution > Gamma > unresolved",
    "```",
    "",
    "## Wallet identity",
    "",
  ];

  for (const r of input.results) {
    lines.push(
      `### ${r.label} (\`${r.wallet}\`)`,
      "",
      "| Field | Value |",
      "|-------|-------|",
      `| requestedWallet | \`${r.identity.requestedWallet}\` |`,
      `| relatedAddresses | ${r.identity.relatedAddresses.map((a) => `\`${a}\``).join(", ") || "—"} |`,
      `| canonicalHistorySubjects | ${r.identity.canonicalHistorySubjects.map((a) => `\`${a}\``).join(", ") || "—"} |`,
      `| confidence | ${r.identity.confidence} |`,
      ""
    );
    if (r.identity.relationshipEvidence.length > 0) {
      lines.push("Evidence:");
      for (const e of r.identity.relationshipEvidence) {
        lines.push(`- \`${e.address}\` (${e.role}): ${e.evidence}`);
      }
      lines.push("");
    }
  }

  lines.push("## API vs chain coverage", "");
  for (const r of input.results) {
    lines.push(
      `### ${r.label}`,
      "",
      "| | API | On-chain |",
      "|--|-----|----------|",
      `| Earliest timestamp | ${iso(r.coverage.apiOldestTimestamp)} | ${iso(r.coverage.chainOldestTimestamp)} |`,
      `| Event count | ${r.coverage.apiEventCount} | ${r.coverage.chainEventCount} |`,
      `| Additional historical (chain before API) | — | ${r.coverage.additionalHistoricalEvents} |`,
      `| Blocks scanned | ${r.coverage.scanStartBlock} → ${r.coverage.scanEndBlock} |`,
      `| onChainHistoryComplete | ${r.coverage.onChainHistoryComplete} |`,
      `| Reconcile match rate | ${pct(r.reconciliation.matchRate)} (${r.reconciliation.matchedEvents}/${r.reconciliation.apiTradeCount} API trades) |`,
      `| Chain-only trades | ${r.reconciliation.chainOnlyEvents} |`,
      `| RPC calls / duration | ${r.fetchStats.rpcCalls} / ${(r.fetchStats.elapsedMs / 1000).toFixed(1)}s |`,
      ""
    );
  }

  lines.push("## Resolution coverage", "");
  for (const r of input.results) {
    const gamma = r.combinedLedgerMetrics?.gammaCoverage;
    lines.push(
      `- **${r.label}**: Gamma final markets ≈ ${gamma?.resolvedAfter ?? "N/A"} / ${gamma?.distinctMarkets ?? "N/A"} (${pct(gamma?.coverageAfterPct)})`
    );
  }
  lines.push("");

  for (const r of input.results) {
    lines.push(`## ${r.wallet.slice(0, 6)} reconciliation`, "");
    lines.push(metricsBlock("API-only", r.apiLedgerMetrics));
    lines.push(metricsBlock("API + Polygon", r.combinedLedgerMetrics));
    const api = r.apiLedgerMetrics;
    const combined = r.combinedLedgerMetrics;
    const materialChange =
      api?.portfolioRealizedRoi !== combined.portfolioRealizedRoi ||
      api?.completedPositionCount !== combined.completedPositionCount ||
      r.coverage.additionalHistoricalEvents > 0;
    lines.push(
      `**Chain history materially changes score:** ${materialChange ? "YES (partial — see coverage)" : "NO"}`,
      ""
    );
    if (r.label === "high_avg_ev_truncated") {
      lines.push(
        `**Can credibilityMetricsValid become true?** ${combined.credibilityMetricsValid ? "YES (with current scan)" : "NO — requires proven full history + resolved truncation reasons"}`,
        ""
      );
    }
    if (r.label === "identity_mismatch_probe") {
      lines.push(
        "**0xd91e identity:** See related addresses and canonical subjects above. Positions/activity mismatch typically means history lives on a proxy or maker/taker address from the probe transaction.",
        ""
      );
    }
  }

  lines.push(
    "## MERGE/SPLIT result",
    "",
    ...input.results.map(
      (r) =>
        `- **${r.label}**: ${r.mergeSplitVerdict} — ${r.mergeSplitNotes.join("; ")}`
    ),
    "",
    "## Feasibility",
    ""
  );

  for (const est of input.feasibility) {
    lines.push(
      `- **${est.wallets.toLocaleString()} wallets**: ~${est.estimatedRpcCalls.toLocaleString()} RPC calls, ~${est.estimatedDurationMinutes.toFixed(0)} min`
    );
  }

  lines.push(
    "",
    "### Architecture comparison",
    "",
    "| Approach | Pros | Cons |",
    "|----------|------|------|",
    "| A. Direct Polygon RPC | No infra; uses existing decoders | Rate limits; O(wallets × blocks) |",
    "| B. Indexed blockchain API | Faster lookups; fewer RPC calls | Cost; vendor lock-in |",
    "| C. Persistent event index | Best for 10k+ wallets; offline queries | Build + maintain index |",
    "",
    "## Final verdict",
    "",
    "See runtime JSON for per-wallet counts. Typical outcome for truncated whales:",
    "- **B** if direct RPC proves history extension but scan cost is prohibitive at scale",
    "- **D** if chain scan within bounded window does not extend before API oldest event",
    "",
    "## Recommended Phase 2D",
    "",
    "Smallest production step: persist decoded `OrderFilled` + `PayoutRedemption` logs for mapped",
    "`pm:{tokenId}` keys only (whale feed assets), backfill from `POLYMARKET_EXCHANGE_INITIAL_BLOCK`",
    "via incremental indexer — do not wire into gates until reconciliation match rate > 95% on",
    "representative wallets.",
    ""
  );

  return lines.join("\n");
}
