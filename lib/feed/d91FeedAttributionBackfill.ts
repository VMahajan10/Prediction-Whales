import { readFileSync } from "node:fs";
import { join } from "node:path";

export const D91_PROXY_WALLET = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
export const D91_FEED_ATTRIBUTION_RESOLVER_VERSION = "economic-order-filled-v1";
export const D91_BACKFILL_EXPECTED_TOTAL = 112;

/** Initial replay baseline; safe/unresolved split is validated from artifact, not fixed. */
export const D91_BACKFILL_INITIAL_SAFE_REATTRIBUTION = 15;
export const D91_BACKFILL_INITIAL_UNRESOLVED = 97;

export const SAFE_ONCHAIN_ECONOMIC_EVIDENCE = new Set(["matched_unique_trader"]);

export const DISALLOWED_SAFE_REATTRIBUTION_EVIDENCE = new Set([
  "no_receipt",
  "ambiguous_traders",
  "no_asset_match",
  "no_order_filled",
  "amount_mismatch",
  "missing_asset_id",
  "topic_only",
  "unresolved",
]);
export const D91_UNRESOLVED_REPRESENTATION =
  "proxy_wallet=NULL (column); payload.proxyWallet removed";

export const DEFAULT_D91_REPLAY_ARTIFACT_PATH = join(
  process.cwd(),
  "tmp/d91-resolver-replay.json",
);

export const DEFAULT_D91_BACKFILL_RESULT_PATH = join(
  process.cwd(),
  "tmp/d91-feed-attribution-backfill-result.json",
);

export type ReplayDetail = {
  tradeId: string;
  txHash?: string;
  feedProxy?: string;
  correctedWallet: string | null;
  source: string | null;
  economicReason?: string;
};

export type ReplayArtifact = {
  plan: {
    previouslyAttributedToD91: number;
    correctedUniquelyResolved: number;
    correctedUnresolved: number;
    backfillPlan: {
      safelyReAttributable: { count: number; tradeIds: string[] };
      unresolved: { count: number; tradeIds: string[] };
    };
  };
  details: ReplayDetail[];
};

export type FeedTradeAttributionRow = {
  tradeId: string;
  proxyWallet: string | null;
  payload: unknown;
};

export type BackfillPlanEntry = {
  tradeId: string;
  kind: "reattribute" | "unresolved";
  correctedWallet: string | null;
  source: string | null;
  economicReason: string | null;
};

export type BackfillAssertionReport = {
  artifactTradeIds: string[];
  expectedTotal: number;
  safeReattributionCount: number;
  unresolvedCount: number;
  duplicateTradeIds: string[];
  missingTradeIds: string[];
  unexpectedCurrentWalletRows: { tradeId: string; proxyWallet: string | null }[];
  outsideArtifactAffectedRows: number;
  assertionErrors: string[];
};

export type DryRunReattributeLine = {
  tradeId: string;
  oldProxyWallet: string;
  newEconomicWallet: string;
  resolverSource: string | null;
  resolverEvidence: string | null;
};

export type DryRunUnresolvedLine = {
  tradeId: string;
  oldProxyWallet: string;
  plannedUnresolvedRepresentation: string;
};

export type BackfillResultArtifact = {
  executedAt: string;
  resolverVersion: string;
  reattributed: { tradeId: string; wallet: string }[];
  unresolvedTradeIds: string[];
  verification: {
    totalRows: number;
    reattributed: number;
    unresolved: number;
    d91Remaining: number;
    outsideArtifactModified: number;
  };
};

export function normalizeTradeId(tradeId: string): string {
  return tradeId.trim().toLowerCase();
}

export function normalizeWallet(wallet: string | null | undefined): string | null {
  const trimmed = wallet?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function loadD91ReplayArtifact(artifactPath: string): ReplayArtifact {
  const raw = readFileSync(artifactPath, "utf8");
  return JSON.parse(raw) as ReplayArtifact;
}

export function findDuplicateTradeIds(tradeIds: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of tradeIds) {
    const normalized = normalizeTradeId(id);
    if (seen.has(normalized)) duplicates.add(normalized);
    seen.add(normalized);
  }
  return [...duplicates].sort();
}

export function buildPlanEntriesFromArtifact(artifact: ReplayArtifact): BackfillPlanEntry[] {
  const safeIds = new Set(
    artifact.plan.backfillPlan.safelyReAttributable.tradeIds.map(normalizeTradeId),
  );
  const unresolvedIds = new Set(
    artifact.plan.backfillPlan.unresolved.tradeIds.map(normalizeTradeId),
  );

  return artifact.details.map((detail) => {
    const tradeId = normalizeTradeId(detail.tradeId);
    const isSafe = safeIds.has(tradeId);
    const isUnresolved = unresolvedIds.has(tradeId);
    if (isSafe === isUnresolved) {
      throw new Error(`trade ${tradeId} must be exclusively safe or unresolved`);
    }

    if (isSafe) {
      const wallet = normalizeWallet(detail.correctedWallet);
      if (!wallet || wallet === D91_PROXY_WALLET) {
        throw new Error(`safe trade ${tradeId} missing corrected wallet`);
      }
      return {
        tradeId,
        kind: "reattribute",
        correctedWallet: wallet,
        source: detail.source,
        economicReason: detail.economicReason ?? null,
      };
    }

    if (detail.correctedWallet != null) {
      throw new Error(`unresolved trade ${tradeId} must not have correctedWallet`);
    }

    return {
      tradeId,
      kind: "unresolved",
      correctedWallet: null,
      source: null,
      economicReason: detail.economicReason ?? null,
    };
  });
}

export function mergePayloadProxyWallet(
  payload: unknown,
  wallet: string,
): Record<string, unknown> {
  const base =
    payload && typeof payload === "object"
      ? { ...(payload as Record<string, unknown>) }
      : {};
  base.proxyWallet = wallet.toLowerCase();
  return base;
}

export function mergePayloadClearProxyWallet(payload: unknown): Record<string, unknown> {
  const base =
    payload && typeof payload === "object"
      ? { ...(payload as Record<string, unknown>) }
      : {};
  delete base.proxyWallet;
  return base;
}

export function buildNextRowState(
  row: FeedTradeAttributionRow,
  entry: BackfillPlanEntry,
): { proxyWallet: string | null; payload: Record<string, unknown> } {
  if (entry.kind === "reattribute" && entry.correctedWallet) {
    return {
      proxyWallet: entry.correctedWallet,
      payload: mergePayloadProxyWallet(row.payload, entry.correctedWallet),
    };
  }
  return {
    proxyWallet: null,
    payload: mergePayloadClearProxyWallet(row.payload),
  };
}

export function validateSafeReattributionEvidence(artifact: ReplayArtifact): string[] {
  const errors: string[] = [];
  const safeIds = artifact.plan.backfillPlan.safelyReAttributable.tradeIds.map(
    normalizeTradeId,
  );
  const detailById = new Map(
    artifact.details.map((d) => [normalizeTradeId(d.tradeId), d] as const),
  );

  for (const tradeId of safeIds) {
    const detail = detailById.get(tradeId);
    if (!detail) {
      errors.push(`safe re-attribution trade missing from details: ${tradeId}`);
      continue;
    }

    const evidence = detail.economicReason ?? "no_receipt";

    if (detail.source === "onchain-economic") {
      if (!SAFE_ONCHAIN_ECONOMIC_EVIDENCE.has(evidence)) {
        errors.push(
          `safe trade ${tradeId} source=onchain-economic requires matched_unique_trader evidence, got ${evidence}`,
        );
      }
      const wallet = normalizeWallet(detail.correctedWallet);
      if (!wallet || wallet === D91_PROXY_WALLET) {
        errors.push(`safe trade ${tradeId} missing non-d91 correctedWallet`);
      }
      continue;
    }

    if (DISALLOWED_SAFE_REATTRIBUTION_EVIDENCE.has(evidence)) {
      errors.push(`safe trade ${tradeId} has disallowed evidence: ${evidence}`);
    }
  }

  return errors;
}

export function validateArtifactPlanCounts(artifact: ReplayArtifact): string[] {
  const errors: string[] = [];
  const safe = artifact.plan.backfillPlan.safelyReAttributable;
  const unresolved = artifact.plan.backfillPlan.unresolved;
  const total = artifact.details.length;

  if (total !== D91_BACKFILL_EXPECTED_TOTAL) {
    errors.push(`artifact total ${total} !== ${D91_BACKFILL_EXPECTED_TOTAL}`);
  }
  if (safe.count + unresolved.count !== D91_BACKFILL_EXPECTED_TOTAL) {
    errors.push(
      `safe + unresolved (${safe.count + unresolved.count}) !== ${D91_BACKFILL_EXPECTED_TOTAL}`,
    );
  }
  if (artifact.plan.previouslyAttributedToD91 !== D91_BACKFILL_EXPECTED_TOTAL) {
    errors.push(
      `previouslyAttributedToD91 ${artifact.plan.previouslyAttributedToD91} !== ${D91_BACKFILL_EXPECTED_TOTAL}`,
    );
  }
  if (safe.tradeIds.length !== safe.count || unresolved.tradeIds.length !== unresolved.count) {
    errors.push("backfillPlan tradeId list length does not match count fields");
  }

  const duplicateTradeIds = findDuplicateTradeIds(artifact.details.map((d) => d.tradeId));
  if (duplicateTradeIds.length > 0) {
    errors.push(`duplicateTradeIds: ${duplicateTradeIds.join(", ")}`);
  }

  try {
    const entries = buildPlanEntriesFromArtifact(artifact);
    const reattribute = entries.filter((e) => e.kind === "reattribute").length;
    const unres = entries.filter((e) => e.kind === "unresolved").length;
    if (reattribute !== safe.count) {
      errors.push(`detail-derived safe count ${reattribute} !== plan safe ${safe.count}`);
    }
    if (unres !== unresolved.count) {
      errors.push(
        `detail-derived unresolved count ${unres} !== plan unresolved ${unresolved.count}`,
      );
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  errors.push(...validateSafeReattributionEvidence(artifact));

  return errors;
}

export function buildAssertionReport(
  artifact: ReplayArtifact,
  dbRows: FeedTradeAttributionRow[],
  plannedMutationTradeIds: string[],
): BackfillAssertionReport {
  const artifactTradeIds = artifact.details.map((d) => normalizeTradeId(d.tradeId));
  const dbById = new Map(
    dbRows.map((row) => [normalizeTradeId(row.tradeId), row] as const),
  );

  const duplicateTradeIds = findDuplicateTradeIds(artifactTradeIds);
  const missingTradeIds = artifactTradeIds.filter((id) => !dbById.has(id));

  const unexpectedCurrentWalletRows: { tradeId: string; proxyWallet: string | null }[] = [];
  for (const id of artifactTradeIds) {
    const row = dbById.get(id);
    if (!row) continue;
    if (normalizeWallet(row.proxyWallet) !== D91_PROXY_WALLET) {
      unexpectedCurrentWalletRows.push({
        tradeId: id,
        proxyWallet: row.proxyWallet,
      });
    }
  }

  const artifactIdSet = new Set(artifactTradeIds);
  const outsideArtifactAffectedRows = plannedMutationTradeIds.filter(
    (id) => !artifactIdSet.has(normalizeTradeId(id)),
  ).length;

  const assertionErrors = [
    ...validateArtifactPlanCounts(artifact),
    ...(duplicateTradeIds.length > 0
      ? [`duplicateTradeIds count ${duplicateTradeIds.length} !== 0`]
      : []),
    ...(missingTradeIds.length > 0
      ? [`missingRows count ${missingTradeIds.length} !== 0`]
      : []),
    ...(unexpectedCurrentWalletRows.length > 0
      ? [
          `unexpectedCurrentWalletRows count ${unexpectedCurrentWalletRows.length} !== 0`,
        ]
      : []),
    ...(outsideArtifactAffectedRows > 0
      ? [`outsideArtifactAffectedRows ${outsideArtifactAffectedRows} !== 0`]
      : []),
  ];

  const safe = artifact.plan.backfillPlan.safelyReAttributable.count;
  const unresolved = artifact.plan.backfillPlan.unresolved.count;

  return {
    artifactTradeIds,
    expectedTotal: D91_BACKFILL_EXPECTED_TOTAL,
    safeReattributionCount: safe,
    unresolvedCount: unresolved,
    duplicateTradeIds,
    missingTradeIds,
    unexpectedCurrentWalletRows,
    outsideArtifactAffectedRows,
    assertionErrors,
  };
}

export function assertionsPass(report: BackfillAssertionReport): boolean {
  return report.assertionErrors.length === 0;
}

export function buildDryRunLines(
  artifact: ReplayArtifact,
  dbRows: FeedTradeAttributionRow[],
): {
  reattributions: DryRunReattributeLine[];
  unresolved: DryRunUnresolvedLine[];
} {
  const dbById = new Map(
    dbRows.map((row) => [normalizeTradeId(row.tradeId), row] as const),
  );
  const detailById = new Map(
    artifact.details.map((d) => [normalizeTradeId(d.tradeId), d] as const),
  );
  const safeIds = new Set(
    artifact.plan.backfillPlan.safelyReAttributable.tradeIds.map(normalizeTradeId),
  );

  const reattributions: DryRunReattributeLine[] = [];
  const unresolvedLines: DryRunUnresolvedLine[] = [];

  for (const tradeId of artifact.plan.backfillPlan.safelyReAttributable.tradeIds.map(
    normalizeTradeId,
  )) {
    const row = dbById.get(tradeId);
    const detail = detailById.get(tradeId);
    const wallet = normalizeWallet(detail?.correctedWallet);
    if (!wallet) continue;
    reattributions.push({
      tradeId,
      oldProxyWallet: normalizeWallet(row?.proxyWallet) ?? D91_PROXY_WALLET,
      newEconomicWallet: wallet,
      resolverSource: detail?.source ?? null,
      resolverEvidence: detail?.economicReason ?? null,
    });
  }

  for (const tradeId of artifact.plan.backfillPlan.unresolved.tradeIds.map(normalizeTradeId)) {
    const row = dbById.get(tradeId);
    unresolvedLines.push({
      tradeId,
      oldProxyWallet: normalizeWallet(row?.proxyWallet) ?? D91_PROXY_WALLET,
      plannedUnresolvedRepresentation: D91_UNRESOLVED_REPRESENTATION,
    });
  }

  if (reattributions.length !== safeIds.size) {
    throw new Error("reattribution dry-run line count mismatch");
  }

  return { reattributions, unresolved: unresolvedLines };
}

export type PostWriteVerification = {
  ok: boolean;
  errors: string[];
  totalRows: number;
  reattributed: number;
  unresolved: number;
  d91Remaining: number;
  rowsChanged: number;
};

export function verifyPostWriteState(
  rows: FeedTradeAttributionRow[],
  planEntries: BackfillPlanEntry[],
): PostWriteVerification {
  const planById = new Map(planEntries.map((e) => [e.tradeId, e] as const));
  const expectedSafe = planEntries.filter((e) => e.kind === "reattribute").length;
  const expectedUnresolved = planEntries.filter((e) => e.kind === "unresolved").length;
  const errors: string[] = [];
  let reattributed = 0;
  let unresolved = 0;
  let d91Remaining = 0;

  if (rows.length !== D91_BACKFILL_EXPECTED_TOTAL) {
    errors.push(`post-write row count ${rows.length} !== ${D91_BACKFILL_EXPECTED_TOTAL}`);
  }

  for (const row of rows) {
    const tradeId = normalizeTradeId(row.tradeId);
    const entry = planById.get(tradeId);
    if (!entry) {
      errors.push(`unexpected tradeId in post-write set: ${tradeId}`);
      continue;
    }

    const wallet = normalizeWallet(row.proxyWallet);
    if (wallet === D91_PROXY_WALLET) {
      d91Remaining += 1;
    }

    const expected = buildNextRowState(row, entry);
    if (entry.kind === "reattribute") {
      if (wallet !== entry.correctedWallet) {
        errors.push(`trade ${tradeId} wallet ${wallet} !== ${entry.correctedWallet}`);
      } else {
        reattributed += 1;
      }
    } else if (wallet !== null) {
      errors.push(`trade ${tradeId} expected unresolved null wallet, got ${wallet}`);
    } else {
      unresolved += 1;
    }

    const payloadWallet = extractPayloadProxyWallet(row.payload);
    if (entry.kind === "reattribute") {
      if (payloadWallet !== entry.correctedWallet) {
        errors.push(`trade ${tradeId} payload.proxyWallet mismatch`);
      }
    } else if (payloadWallet != null) {
      errors.push(`trade ${tradeId} payload.proxyWallet should be cleared`);
    }

    if (normalizeWallet(expected.proxyWallet) !== wallet) {
      errors.push(`trade ${tradeId} inconsistent expected proxy state`);
    }
  }

  const rowsChanged = rows.length;

  if (reattributed !== expectedSafe) {
    errors.push(`reattributed ${reattributed} !== ${expectedSafe}`);
  }
  if (unresolved !== expectedUnresolved) {
    errors.push(`unresolved ${unresolved} !== ${expectedUnresolved}`);
  }
  if (d91Remaining !== 0) {
    errors.push(`d91Remaining ${d91Remaining} !== 0`);
  }
  if (rowsChanged !== D91_BACKFILL_EXPECTED_TOTAL) {
    errors.push(`rowsChanged ${rowsChanged} !== ${D91_BACKFILL_EXPECTED_TOTAL}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    totalRows: rows.length,
    reattributed,
    unresolved,
    d91Remaining,
    rowsChanged,
  };
}

function extractPayloadProxyWallet(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { proxyWallet?: unknown }).proxyWallet;
  return typeof value === "string" ? normalizeWallet(value) : null;
}

export function buildResultArtifact(
  planEntries: BackfillPlanEntry[],
  verification: PostWriteVerification,
): BackfillResultArtifact {
  const reattributed = planEntries
    .filter((e) => e.kind === "reattribute" && e.correctedWallet)
    .map((e) => ({ tradeId: e.tradeId, wallet: e.correctedWallet as string }));

  const unresolvedTradeIds = planEntries
    .filter((e) => e.kind === "unresolved")
    .map((e) => e.tradeId);

  return {
    executedAt: new Date().toISOString(),
    resolverVersion: D91_FEED_ATTRIBUTION_RESOLVER_VERSION,
    reattributed,
    unresolvedTradeIds,
    verification: {
      totalRows: verification.totalRows,
      reattributed: verification.reattributed,
      unresolved: verification.unresolved,
      d91Remaining: verification.d91Remaining,
      outsideArtifactModified: 0,
    },
  };
}

/** In-memory simulation for tests: apply plan to rows without DB. */
export function applyPlanToRows(
  rows: FeedTradeAttributionRow[],
  planEntries: BackfillPlanEntry[],
): FeedTradeAttributionRow[] {
  const planById = new Map(planEntries.map((e) => [e.tradeId, e] as const));
  return rows.map((row) => {
    const entry = planById.get(normalizeTradeId(row.tradeId));
    if (!entry) return row;
    const next = buildNextRowState(row, entry);
    return {
      ...row,
      tradeId: normalizeTradeId(row.tradeId),
      proxyWallet: next.proxyWallet,
      payload: next.payload,
    };
  });
}

export type PgQueryable = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export async function fetchFeedTradesByIds(
  client: PgQueryable,
  tradeIds: string[],
): Promise<FeedTradeAttributionRow[]> {
  if (tradeIds.length === 0) return [];
  const res = await client.query(
    `SELECT trade_id, proxy_wallet, payload
     FROM feed_trades
     WHERE trade_id = ANY($1::text[])`,
    [tradeIds],
  );
  return res.rows.map((row) => ({
    tradeId: normalizeTradeId(String(row.trade_id)),
    proxyWallet: (row.proxy_wallet as string | null) ?? null,
    payload: row.payload,
  }));
}

export type ExecuteBackfillOptions = {
  client: PgQueryable;
  artifact: ReplayArtifact;
  planEntries: BackfillPlanEntry[];
  dryRun: boolean;
  /** When set, post-write verification uses this instead of re-reading DB (tests). */
  simulatePostWriteRows?: FeedTradeAttributionRow[];
  forcePostWriteVerificationFailure?: boolean;
};

export type ExecuteBackfillOutcome =
  | { ok: true; dryRun: true; report: BackfillAssertionReport }
  | { ok: true; dryRun: false; result: BackfillResultArtifact; report: BackfillAssertionReport }
  | { ok: false; report: BackfillAssertionReport; error: string };

export async function executeD91FeedAttributionBackfill(
  options: ExecuteBackfillOptions,
): Promise<ExecuteBackfillOutcome> {
  const { artifact, planEntries, dryRun, client } = options;
  const tradeIds = planEntries.map((e) => e.tradeId);
  const dbRows = await fetchFeedTradesByIds(client, tradeIds);
  const report = buildAssertionReport(artifact, dbRows, tradeIds);

  if (!assertionsPass(report)) {
    return {
      ok: false,
      report,
      error: report.assertionErrors.join("; "),
    };
  }

  if (dryRun) {
    return { ok: true, dryRun: true, report };
  }

  const planById = new Map(planEntries.map((e) => [e.tradeId, e] as const));
  const rowById = new Map(dbRows.map((r) => [r.tradeId, r] as const));

  await client.query("BEGIN");
  try {
    let updatesApplied = 0;
    for (const tradeId of tradeIds) {
      const entry = planById.get(tradeId);
      const row = rowById.get(tradeId);
      if (!entry || !row) {
        throw new Error(`missing plan or row for ${tradeId}`);
      }
      if (normalizeWallet(row.proxyWallet) !== D91_PROXY_WALLET) {
        throw new Error(`precondition failed for ${tradeId}: proxy_wallet is not d91`);
      }

      const next = buildNextRowState(row, entry);
      const updateRes = await client.query(
        `UPDATE feed_trades
         SET proxy_wallet = $1,
             payload = $2::jsonb,
             updated_at = NOW()
         WHERE trade_id = $3
           AND lower(proxy_wallet) = $4`,
        [
          next.proxyWallet,
          JSON.stringify(next.payload),
          tradeId,
          D91_PROXY_WALLET,
        ],
      );
      if ((updateRes.rowCount ?? 0) !== 1) {
        throw new Error(`expected exactly 1 row updated for ${tradeId}`);
      }
      updatesApplied += 1;
    }

    if (updatesApplied !== D91_BACKFILL_EXPECTED_TOTAL) {
      throw new Error(
        `updatesApplied ${updatesApplied} !== ${D91_BACKFILL_EXPECTED_TOTAL}`,
      );
    }

    let postRows: FeedTradeAttributionRow[];
    if (options.simulatePostWriteRows) {
      postRows = options.simulatePostWriteRows;
    } else {
      postRows = await fetchFeedTradesByIds(client, tradeIds);
    }

    const verification = verifyPostWriteState(postRows, planEntries);
    if (options.forcePostWriteVerificationFailure) {
      verification.ok = false;
      verification.errors.push("forced verification failure");
    }

    if (!verification.ok) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        report,
        error: verification.errors.join("; "),
      };
    }

    await client.query("COMMIT");
    const result = buildResultArtifact(planEntries, verification);
    return { ok: true, dryRun: false, result, report };
  } catch (err) {
    await client.query("ROLLBACK");
    return {
      ok: false,
      report,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatDryRunReport(
  report: BackfillAssertionReport,
  lines: ReturnType<typeof buildDryRunLines>,
): string {
  const chunks: string[] = [];
  chunks.push("d91 feed attribution backfill (DRY-RUN)");
  chunks.push(`artifact trade IDs: ${report.artifactTradeIds.length}`);
  chunks.push(`expected total = ${report.expectedTotal}`);
  chunks.push(`safe re-attribution count = ${report.safeReattributionCount}`);
  chunks.push(`unresolved count = ${report.unresolvedCount}`);
  chunks.push(
    `duplicate trade IDs in artifact: ${report.duplicateTradeIds.length}`,
  );
  chunks.push(`missing trade IDs in DB: ${report.missingTradeIds.length}`);
  chunks.push(
    `rows whose current proxy_wallet is not d91: ${report.unexpectedCurrentWalletRows.length}`,
  );
  chunks.push(
    `rows outside the artifact that would be touched = ${report.outsideArtifactAffectedRows}`,
  );

  if (report.assertionErrors.length > 0) {
    chunks.push("assertion failures:");
    for (const err of report.assertionErrors) chunks.push(`  - ${err}`);
  }

  chunks.push("");
  chunks.push(`safe re-attributions (${report.safeReattributionCount}):`);
  for (const line of lines.reattributions) {
    chunks.push(
      `  ${line.tradeId} | old=${line.oldProxyWallet} | new=${line.newEconomicWallet} | source=${line.resolverSource ?? "null"} | evidence=${line.resolverEvidence ?? "null"}`,
    );
  }

  chunks.push("");
  chunks.push(`unresolved (${report.unresolvedCount}):`);
  for (const line of lines.unresolved) {
    chunks.push(
      `  ${line.tradeId} | old=${line.oldProxyWallet} | plan=${line.plannedUnresolvedRepresentation}`,
    );
  }

  return chunks.join("\n");
}
