import type {
  IndexedAuditWalletResult,
  IndexedFeasibilityEstimate,
  IndexedProviderEvaluation,
} from "@/lib/walletLedger/indexed/types";

function iso(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "N/A";
  return new Date(ts * 1000).toISOString();
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

export function formatPhase2dMarkdownReport(input: {
  providerEvaluations: IndexedProviderEvaluation[];
  results: IndexedAuditWalletResult[];
  feasibility: IndexedFeasibilityEstimate[];
  phase2cBaseline?: { rpcCalls: number; elapsedSec: number };
}): string {
  const lines: string[] = [
    "# Phase 2D Indexed Polygon History Provider Spike",
    "",
    "## A. Provider/indexed-source options tested",
    "",
  ];

  for (const ev of input.providerEvaluations) {
    lines.push(
      `### ${ev.providerId}`,
      "",
      `- Available: **${ev.probe.available}**`,
      `- Probe latency: ${ev.probe.probeLatencyMs}ms`,
      `- Error: ${ev.probe.error ?? "none"}`,
      `- Wallet topic filter: ${ev.probe.capabilities.walletTopicFilter}`,
      `- Block range filter: ${ev.probe.capabilities.blockRangeFilter}`,
      `- Pagination: page=${ev.probe.capabilities.pagePagination} cursor=${ev.probe.capabilities.cursorPagination}`,
      `- Max block range/request: ${ev.probe.capabilities.maxBlockRangePerRequest ?? "n/a"}`,
      `- Requires API key: ${ev.probe.capabilities.requiresApiKey}`,
      `- Notes: ${ev.probe.notes.join("; ")}`,
      ""
    );
    if (ev.sampleFetch) {
      lines.push(
        `- Sample fetch: ${ev.sampleFetch.requests} requests, ${ev.sampleFetch.logsReturned} logs, ${ev.sampleFetch.elapsedMs}ms`,
        ""
      );
    }
  }

  lines.push("## B. Full-history coverage", "");
  for (const r of input.results) {
    lines.push(
      `### ${r.label} (provider: ${r.providerId})`,
      "",
      `| | API | Indexed |`,
      `|--|-----|---------|`,
      `| Oldest timestamp | ${iso(r.coverage.apiOldestTimestamp)} | ${iso(r.coverage.indexedOldestTimestamp)} |`,
      `| Events | ${r.coverage.apiEventCount} | ${r.coverage.indexedEventCount} |`,
      `| Before API boundary | — | ${r.coverage.eventsBeforeApiBoundary} |`,
      `| Blocks scanned | ${r.coverage.scanFromBlock} → ${r.coverage.scanToBlock} |`,
      `| indexedHistoryComplete | ${r.coverage.indexedHistoryComplete} |`,
      `| Requests / duration | — | ${r.fetchStats.requests} / ${(r.fetchStats.elapsedMs / 1000).toFixed(1)}s |`,
      ""
    );
  }

  for (const r of input.results) {
    if (r.label === "buy_sell_active" || r.wallet.startsWith("0x0562")) {
      lines.push(
        "## C. 0x0562",
        "",
        `- Extends before API boundary: **${r.extendsBeforeApiBoundary ? "YES" : "NO"}**`,
        `- Additional events before API: ${r.coverage.eventsBeforeApiBoundary}`,
        `- Additional completed positions: ${r.coverage.additionalCompletedPositions}`,
        `- credibilityMetricsValid: ${r.credibilityMetricsValidBefore} → ${r.credibilityMetricsValidAfter}`,
        `- historyComplete: ${r.historyCompleteBefore} → ${r.historyCompleteAfter}`,
        ""
      );
    }
    if (r.label === "high_avg_ev_truncated" || r.wallet.startsWith("0x7e59")) {
      lines.push(
        "## D. 0x7e59",
        "",
        `- Extends before API boundary: **${r.extendsBeforeApiBoundary ? "YES" : "NO"}**`,
        `- Additional events before API: ${r.coverage.eventsBeforeApiBoundary}`,
        `- Additional completed positions: ${r.coverage.additionalCompletedPositions}`,
        `- credibilityMetricsValid: ${r.credibilityMetricsValidBefore} → ${r.credibilityMetricsValidAfter}`,
        `- historyComplete: ${r.historyCompleteBefore} → ${r.historyCompleteAfter}`,
        ""
      );
    }
    if (r.label === "identity_mismatch_probe" || r.wallet.startsWith("0xd91e")) {
      lines.push(
        "## E. 0xd91e",
        "",
        `- Related addresses: ${r.identity.relatedAddresses.map((a) => `\`${a}\``).join(", ") || "—"}`,
        `- Canonical subjects: ${r.identity.canonicalHistorySubjects.map((a) => `\`${a}\``).join(", ")}`,
        `- API events: ${r.coverage.apiEventCount}`,
        `- Indexed events (multi-subject): ${r.coverage.indexedEventCount}`,
        `- Reconstructed efficiently: **${r.coverage.indexedEventCount > 0 && r.fetchStats.elapsedMs < 120_000 ? "YES (small subject set)" : "PARTIAL"}**`,
        ""
      );
    }
  }

  lines.push(
    "## F. Resolution architecture",
    "",
    "Wallet history (per subject): OrderFilled, Split, Merge, Redeem",
    "Market resolution (global): ConditionResolution keyed by conditionId",
    "",
    "Resolution fetches are separated from wallet history in `resolutionIndex.ts`.",
    "Each conditionId triggers one indexed query — suitable for a shared resolution table in Phase 2E.",
    "",
    "## G. Cost/performance estimates",
    ""
  );

  for (const est of input.feasibility) {
    lines.push(
      `- **${est.wallets.toLocaleString()} wallets**: ~${est.estimatedRequests.toLocaleString()} requests, ~${est.estimatedDurationMinutes.toFixed(0)} min${est.estimatedMonthlyCostUsd != null ? `, ~$${est.estimatedMonthlyCostUsd}/mo` : ""}`
    );
  }

  if (input.phase2cBaseline) {
    lines.push(
      "",
      `Phase 2C direct RPC baseline (bounded 100k blocks): ~${input.phase2cBaseline.rpcCalls} calls, ~${input.phase2cBaseline.elapsedSec}s`,
      ""
    );
  }

  const anyExtends = input.results.some((r) => r.extendsBeforeApiBoundary);
  const etherscanAvailable = input.providerEvaluations.find(
    (e) => e.providerId === "etherscan_v2"
  )?.probe.available;

  let verdict = "B";
  if (!etherscanAvailable && !anyExtends) verdict = "D";
  if (etherscanAvailable && anyExtends) verdict = "A";

  lines.push(
    "## H. Final verdict",
    "",
    `**${verdict}** — see runtime JSON for per-wallet detail.`,
    "",
    "- **A**: Indexed provider solves history — build Phase 2E persistence",
    "- **B**: Indexed helps but material gaps remain",
    "- **C**: Build own Polygon event index",
    "- **D**: On-chain approach insufficient",
    ""
  );

  return lines.join("\n");
}
