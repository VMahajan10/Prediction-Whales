import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hydrateShadowRowsWithHistoricalPerformance } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import {
  buildConfusionMatrix,
  buildProductionVsHistoricalPerformanceMatrix,
  type CredibilityConfusionMatrix,
  type ShadowWalletComparison,
} from "@/lib/walletLedger/indexed/shadow/taxonomy";
import {
  assertShadowReportReconciliation,
  type CohortProductionSpec,
} from "@/lib/walletLedger/indexed/shadow/productionReconciliation";

export type ShadowWalletOutcomeCategory =
  | "metrics-safe"
  | "metrics-unsafe"
  | "unusable"
  | "wallet-failed"
  | "deferred-infra"
  | "internal-error"
  | "infra-failed"
  | "not-attempted";

export interface ShadowWalletOutcomeRow {
  wallet: string;
  label: string;
  cohortReason: string;
  outcome: ShadowWalletOutcomeCategory;
  historyValidity?: string;
  productionDecision?: boolean | null;
  apiReconstructedDecision?: boolean | null;
  indexedDecision?: boolean;
  indexedDataValidityDecision?: string;
  historicalPerformanceDecision?: string;
  status?: string;
}

export interface ShadowBatchSummary {
  batchId: string;
  cohortSelected: number;
  walletsEvaluated: number;
  walletsAttempted: number;
  successful: number;
  failed: number;
  unusable: number;
  metricsSafe: number;
  metricsUnsafe: number;
  unusableValidity: number;
  infraFailed: number;
  walletFailed: number;
  deferredInfra: number;
  pending: number;
  batchComplete: boolean;
  infraInterrupted: boolean;
  notAttempted: number;
  partialButMetricsSafe: number;
  partialAndMetricsUnsafe: number;
  cohortProductionPass: number;
  cohortProductionFail: number;
  cohortProductionUnknown: number;
  productionPass: number;
  productionFail: number;
  productionUnknown: number;
  apiPass: number;
  apiFail: number;
  indexedPass: number;
  indexedFail: number;
  historicalPerformancePass: number;
  historicalPerformanceFail: number;
  historicalPerformanceUnknown: number;
  productionVsIndexed: CredibilityConfusionMatrix;
  productionVsHistoricalPerformance: CredibilityConfusionMatrix;
  apiVsIndexed: CredibilityConfusionMatrix;
  productionVsIndexedDenominator: number;
  apiVsIndexedDenominator: number;
  disagreementCounts: Record<string, number>;
  medianRuntimeMs: number;
  p90RuntimeMs: number;
  p95RuntimeMs: number;
  slowestWallets: Array<{ wallet: string; totalMs: number }>;
  totalEtherscanRequests: number;
  totalRpcAttempts: number;
  walletOutcomes: ShadowWalletOutcomeRow[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[idx] ?? 0;
}

export function categorizeShadowWalletOutcome(
  row: ShadowWalletComparison | undefined
): ShadowWalletOutcomeCategory {
  if (!row) return "not-attempted";
  if (row.status === "deferred_infra") return "deferred-infra";
  if (row.status === "internal_error") return "internal-error";
  if (row.status === "failed") return "deferred-infra";
  if (row.status === "wallet_failed") return "wallet-failed";
  if (row.status === "unusable") {
    if (row.historyValidity === "partial-and-metrics-unsafe") {
      return "metrics-unsafe";
    }
    return "unusable";
  }
  if (row.status === "complete") return "metrics-safe";
  return "not-attempted";
}

export function summarizeShadowBatch(input: {
  batchId: string;
  cohort: CohortProductionSpec[];
  rows: ShadowWalletComparison[];
  batchComplete?: boolean;
  infraInterrupted?: boolean;
  skipReconciliationAssertions?: boolean;
}): ShadowBatchSummary {
  const hydratedRows = hydrateShadowRowsWithHistoricalPerformance(input.rows);
  const rowByWallet = new Map(
    hydratedRows.map((row) => [row.wallet.toLowerCase(), row])
  );

  const walletOutcomes: ShadowWalletOutcomeRow[] = input.cohort.map((spec) => {
    const row = rowByWallet.get(spec.wallet.toLowerCase());
    return {
      wallet: spec.wallet,
      label: spec.label,
      cohortReason: spec.cohortReason,
      outcome: categorizeShadowWalletOutcome(row),
      historyValidity: row?.historyValidity,
      productionDecision: row?.productionDecision,
      apiReconstructedDecision: row?.apiReconstructedDecision,
      indexedDecision: row?.indexedDecision,
      indexedDataValidityDecision: row?.indexedDataValidityDecision,
      historicalPerformanceDecision: row?.historicalPerformanceDecision,
      status: row?.status,
    };
  });

  const attempted = walletOutcomes.filter((w) => w.outcome !== "not-attempted");
  const metricsSafeRows = hydratedRows.filter((r) => r.status === "complete");
  const metricsSafe = walletOutcomes.filter((w) => w.outcome === "metrics-safe").length;
  const metricsUnsafe = walletOutcomes.filter((w) => w.outcome === "metrics-unsafe").length;
  const unusableValidity = walletOutcomes.filter((w) => w.outcome === "unusable").length;
  const infraFailed = walletOutcomes.filter((w) => w.outcome === "infra-failed").length;
  const walletFailed = walletOutcomes.filter((w) => w.outcome === "wallet-failed").length;
  const deferredInfra = walletOutcomes.filter((w) => w.outcome === "deferred-infra").length;
  const notAttempted = walletOutcomes.filter((w) => w.outcome === "not-attempted").length;
  const pending = walletOutcomes.filter((w) => w.outcome === "not-attempted").length;

  const cohortProductionPass = input.cohort.filter(
    (w) => w.productionGate === "pass"
  ).length;
  const cohortProductionFail = input.cohort.filter(
    (w) => w.productionGate === "fail"
  ).length;
  const cohortProductionUnknown = input.cohort.filter(
    (w) => w.productionGate === "unknown"
  ).length;

  const productionPass = metricsSafeRows.filter(
    (r) => r.productionDecision === true
  ).length;
  const productionFail = metricsSafeRows.filter(
    (r) => r.productionDecision === false
  ).length;
  const productionUnknown = metricsSafeRows.filter(
    (r) => r.productionDecision == null
  ).length;
  const productionMetadataMissing = metricsSafeRows.filter(
    (r) => r.evidence.comparisonMetadataMissing === true
  ).length;
  const apiMetadataMissing = metricsSafeRows.filter(
    (r) =>
      r.apiReconstructedDecision == null &&
      r.evidence.apiObservationSource === "comparison_metadata_missing"
  ).length;
  const apiPass = metricsSafeRows.filter(
    (r) => r.apiReconstructedDecision === true
  ).length;
  const apiFail = metricsSafeRows.filter(
    (r) => r.apiReconstructedDecision === false
  ).length;
  const indexedPass = metricsSafeRows.filter((r) => r.indexedDecision).length;
  const indexedFail = metricsSafeRows.filter((r) => !r.indexedDecision).length;
  const historicalPerformancePass = metricsSafeRows.filter(
    (r) => r.historicalPerformanceDecision === "PASS"
  ).length;
  const historicalPerformanceFail = metricsSafeRows.filter(
    (r) => r.historicalPerformanceDecision === "FAIL"
  ).length;
  const historicalPerformanceUnknown = metricsSafeRows.filter(
    (r) =>
      r.historicalPerformanceDecision == null ||
      r.historicalPerformanceDecision === "UNKNOWN"
  ).length;

  const disagreementCounts: Record<string, number> = {};
  for (const row of metricsSafeRows) {
    for (const reason of row.productionReasons) {
      disagreementCounts[`production:${reason}`] =
        (disagreementCounts[`production:${reason}`] ?? 0) + 1;
    }
    for (const reason of row.apiReasons) {
      disagreementCounts[`api:${reason}`] =
        (disagreementCounts[`api:${reason}`] ?? 0) + 1;
    }
  }

  const runtimes = attempted
    .map((w) => {
      const row = rowByWallet.get(w.wallet.toLowerCase());
      return Number(row?.performance?.totalMs ?? 0);
    })
    .filter((n) => n > 0);
  const slowestWallets = metricsSafeRows
    .map((r) => ({ wallet: r.wallet, totalMs: Number(r.performance?.totalMs ?? 0) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10);

  const productionVsIndexed = buildConfusionMatrix(metricsSafeRows, "production");
  const productionVsHistoricalPerformance =
    buildProductionVsHistoricalPerformanceMatrix(metricsSafeRows);
  const apiVsIndexed = buildConfusionMatrix(metricsSafeRows, "api");

  const summary: ShadowBatchSummary = {
    batchId: input.batchId,
    cohortSelected: input.cohort.length,
    walletsEvaluated: attempted.length,
    walletsAttempted: attempted.length,
    successful: metricsSafe,
    failed: infraFailed,
    unusable: metricsUnsafe + unusableValidity,
    metricsSafe,
    metricsUnsafe,
    unusableValidity,
    infraFailed,
    walletFailed,
    deferredInfra,
    pending,
    batchComplete: input.batchComplete ?? true,
    infraInterrupted: input.infraInterrupted ?? false,
    notAttempted,
    partialButMetricsSafe: metricsSafeRows.filter(
      (r) => r.historyValidity === "partial-but-metrics-safe"
    ).length,
    partialAndMetricsUnsafe: metricsUnsafe,
    cohortProductionPass,
    cohortProductionFail,
    cohortProductionUnknown,
    productionPass,
    productionFail,
    productionUnknown,
    apiPass,
    apiFail,
    indexedPass,
    indexedFail,
    historicalPerformancePass,
    historicalPerformanceFail,
    historicalPerformanceUnknown,
    productionVsIndexed,
    productionVsHistoricalPerformance,
    apiVsIndexed,
    productionVsIndexedDenominator: productionVsIndexed.comparable,
    apiVsIndexedDenominator: apiVsIndexed.comparable,
    disagreementCounts,
    medianRuntimeMs: percentile(runtimes, 50),
    p90RuntimeMs: percentile(runtimes, 90),
    p95RuntimeMs: percentile(runtimes, 95),
    slowestWallets,
    totalEtherscanRequests: metricsSafeRows.reduce(
      (sum, r) => sum + Number(r.performance?.etherscanRequests ?? 0),
      0
    ),
    totalRpcAttempts: metricsSafeRows.reduce(
      (sum, r) => sum + Number(r.performance?.rpcAttempts ?? 0),
      0
    ),
    walletOutcomes,
  };

  if (!input.skipReconciliationAssertions) {
    assertShadowReportReconciliation({
      summary,
      cohort: input.cohort,
      rows: hydratedRows,
    });
  }

  return summary;
}

function formatMatrix(
  title: string,
  m: CredibilityConfusionMatrix,
  options: { knownLabel: string; unknownLabel?: string }
): string[] {
  const lines = [
    `### ${title}`,
    "",
    `- Metrics-safe total: **n=${m.nMetricsSafeTotal}**`,
    `- Known-decision wallets (${options.knownLabel}): **nKnown=${m.nKnown}**`,
    `- PASS→PASS: **${m.passToPass}**`,
    `- PASS→FAIL: **${m.passToFail}**`,
    `- FAIL→PASS: **${m.failToPass}**`,
    `- FAIL→FAIL: **${m.failToFail}**`,
  ];
  if (options.unknownLabel) {
    lines.push(
      `- Unknown-decision wallets (${options.unknownLabel}): **nUnknown=${m.nUnknown}**`,
      `- NULL→PASS: **${m.nullToPass}** | NULL→FAIL: **${m.nullToFail}**`
    );
  }
  lines.push(
    `- Classification change rate (known only): **${(m.changeRate * 100).toFixed(1)}%**`,
    ""
  );
  return lines;
}

export function writeShadowReports(input: {
  batchId: string;
  rows: ShadowWalletComparison[];
  summary: ShadowBatchSummary;
  cohort: Array<{
    wallet: string;
    label: string;
    cohortReason: string;
    productionGate?: "pass" | "fail" | "unknown";
  }>;
  integrity?: Record<string, number>;
}): { jsonPath: string; mdPath: string } {
  const outDir = join(process.cwd(), "tmp", "wallet-history", "shadow-compare");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `shadow-${input.batchId}.json`);
  const mdPath = join(outDir, `shadow-${input.batchId}.md`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        batchId: input.batchId,
        cohort: input.cohort,
        summary: input.summary,
        rows: input.rows,
        integrity: input.integrity,
      },
      null,
      2
    )
  );

  const consequential = input.rows
    .filter(
      (r) =>
        r.status === "complete" &&
        (!r.productionAgreement || !r.apiAgreement)
    )
    .slice(0, 10);

  const md = [
    `# Shadow credibility comparison — ${input.batchId}`,
    "",
    "## Summary",
    "",
    `- Cohort selected: **${input.summary.cohortSelected}**`,
    `- Wallets attempted: **${input.summary.walletsAttempted}** | Not attempted: **${input.summary.notAttempted}**`,
    `- Metrics-safe: **${input.summary.metricsSafe}** | Metrics-unsafe: **${input.summary.metricsUnsafe}** | Unusable: **${input.summary.unusableValidity}** | Wallet failed: **${input.summary.walletFailed}** | Deferred infra: **${input.summary.deferredInfra}** | Infra failed (legacy): **${input.summary.infraFailed}**`,
    `- Batch complete: **${input.summary.batchComplete}** | Infra interrupted: **${input.summary.infraInterrupted}** | Pending/deferred: **${input.summary.pending}**`,
    `- Cohort production PASS/FAIL/unknown: **${input.summary.cohortProductionPass}** / **${input.summary.cohortProductionFail}** / **${input.summary.cohortProductionUnknown}**`,
    `- Metrics-safe production PASS/FAIL/unknown: **${input.summary.productionPass}** / **${input.summary.productionFail}** / **${input.summary.productionUnknown}**`,
    `- API-reconstructed PASS/FAIL (metrics-safe): **${input.summary.apiPass}** / **${input.summary.apiFail}**`,
    `- Indexed data-validity PASS/FAIL (metrics-safe, legacy indexedDecision): **${input.summary.indexedPass}** / **${input.summary.indexedFail}**`,
    `- Historical performance PASS/FAIL/UNKNOWN (shadow Policy A): **${input.summary.historicalPerformancePass}** / **${input.summary.historicalPerformanceFail}** / **${input.summary.historicalPerformanceUnknown}**`,
    "",
    "## Wallet outcomes (all selected)",
    "",
    ...input.summary.walletOutcomes.map(
      (w) =>
        `- \`${w.wallet}\` (${w.label}) — **${w.outcome}** validity=${w.historyValidity ?? "n/a"} production=${w.productionDecision} indexedDataValidity=${w.indexedDataValidityDecision ?? w.indexedDecision} historicalPerformance=${w.historicalPerformanceDecision ?? "n/a"}`
    ),
    "",
    "## Production vs indexed data validity (A vs C)",
    "",
    ...formatMatrix(
      "Production credibility vs indexed data validity (known PASS/FAIL only)",
      input.summary.productionVsIndexed,
      {
        knownLabel: "production PASS or FAIL",
        unknownLabel: "production UNKNOWN",
      }
    ),
    "## Production vs historical performance (shadow Policy A)",
    "",
    ...formatMatrix(
      "Production credibility vs historical performance (indexed-valid metrics-safe only)",
      input.summary.productionVsHistoricalPerformance,
      {
        knownLabel: "production PASS or FAIL",
        unknownLabel: "production UNKNOWN",
      }
    ),
    "## API-reconstructed vs indexed data validity (B vs C)",
    "",
    ...formatMatrix(
      "API history vs indexed (known PASS/FAIL only)",
      input.summary.apiVsIndexed,
      { knownLabel: "API PASS or FAIL" }
    ),
    "## Disagreement counts",
    "",
    ...Object.entries(input.summary.disagreementCounts).map(
      ([k, v]) => `- ${k}: ${v}`
    ),
    "",
    "## Performance",
    "",
    `- Median runtime: **${(input.summary.medianRuntimeMs / 1000).toFixed(1)}s**`,
    `- P90: **${(input.summary.p90RuntimeMs / 1000).toFixed(1)}s** | P95: **${(input.summary.p95RuntimeMs / 1000).toFixed(1)}s**`,
    `- Total Etherscan requests: **${input.summary.totalEtherscanRequests}**`,
    `- Total RPC attempts (timestamps): **${input.summary.totalRpcAttempts}**`,
    "",
    "## Top consequential disagreements",
    "",
    ...consequential.map(
      (r) =>
        `- \`${r.wallet}\` (${r.label}): production=${r.productionDecision} api=${r.apiReconstructedDecision} indexed=${r.indexedDecision}`
    ),
    "",
    "## Cohort",
    "",
    ...input.cohort.map(
      (c) =>
        `- \`${c.wallet}\` — ${c.label}: ${c.cohortReason} [gate=${c.productionGate ?? "unknown"}]`
    ),
    "",
  ];
  if (input.integrity) {
    md.push("## Database integrity", "");
    for (const [k, v] of Object.entries(input.integrity)) {
      md.push(`- ${k}: ${v}`);
    }
    md.push("");
  }
  writeFileSync(mdPath, md.join("\n"));
  return { jsonPath, mdPath };
}
