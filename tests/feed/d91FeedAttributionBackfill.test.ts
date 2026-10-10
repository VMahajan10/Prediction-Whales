import { describe, expect, it } from "vitest";
import {
  D91_BACKFILL_EXPECTED_TOTAL,
  D91_BACKFILL_INITIAL_SAFE_REATTRIBUTION,
  D91_BACKFILL_INITIAL_UNRESOLVED,
  D91_PROXY_WALLET,
  D91_UNRESOLVED_REPRESENTATION,
  applyPlanToRows,
  assertionsPass,
  buildAssertionReport,
  buildPlanEntriesFromArtifact,
  executeD91FeedAttributionBackfill,
  loadD91ReplayArtifact,
  validateArtifactPlanCounts,
  validateSafeReattributionEvidence,
  verifyPostWriteState,
  type FeedTradeAttributionRow,
  type PgQueryable,
  type ReplayArtifact,
} from "@/lib/feed/d91FeedAttributionBackfill";
import { join } from "node:path";

function makeArtifact(overrides?: Partial<ReplayArtifact>): ReplayArtifact {
  const safeIds = Array.from({ length: D91_BACKFILL_INITIAL_SAFE_REATTRIBUTION }, (_, i) =>
    `0xsafe${String(i).padStart(60, "0")}`,
  );
  const unresolvedIds = Array.from({ length: D91_BACKFILL_INITIAL_UNRESOLVED }, (_, i) =>
    `0xunres${String(i).padStart(59, "0")}`,
  );

  const details = [
    ...safeIds.map((tradeId, i) => ({
      tradeId,
      correctedWallet: `0xnew${String(i).padStart(58, "0")}`,
      source: "onchain-economic" as const,
      economicReason: "matched_unique_trader",
    })),
    ...unresolvedIds.map((tradeId) => ({
      tradeId,
      correctedWallet: null,
      source: null,
      economicReason: "no_receipt",
    })),
  ];

  const base: ReplayArtifact = {
    plan: {
      previouslyAttributedToD91: D91_BACKFILL_EXPECTED_TOTAL,
      correctedUniquelyResolved: D91_BACKFILL_INITIAL_SAFE_REATTRIBUTION,
      correctedUnresolved: D91_BACKFILL_INITIAL_UNRESOLVED,
      backfillPlan: {
        safelyReAttributable: {
          count: D91_BACKFILL_INITIAL_SAFE_REATTRIBUTION,
          tradeIds: safeIds,
        },
        unresolved: {
          count: D91_BACKFILL_INITIAL_UNRESOLVED,
          tradeIds: unresolvedIds,
        },
      },
    },
    details,
  };

  return { ...base, ...overrides };
}

function d91Rows(artifact: ReplayArtifact): FeedTradeAttributionRow[] {
  return artifact.details.map((d) => ({
    tradeId: d.tradeId.toLowerCase(),
    proxyWallet: D91_PROXY_WALLET,
    payload: { id: d.tradeId, proxyWallet: D91_PROXY_WALLET },
  }));
}

function mockClient(rows: FeedTradeAttributionRow[]): PgQueryable & {
  calls: { sql: string; values?: unknown[] }[];
} {
  const store = new Map(rows.map((r) => [r.tradeId.toLowerCase(), { ...r }]));
  const calls: { sql: string; values?: unknown[] }[] = [];

  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ sql: text, values });
      const sql = text.trim();

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (sql.startsWith("SELECT trade_id")) {
        const ids = (values?.[0] as string[]) ?? [];
        const out = ids
          .map((id) => store.get(id.toLowerCase()))
          .filter(Boolean) as FeedTradeAttributionRow[];
        return {
          rows: out.map((r) => ({
            trade_id: r.tradeId,
            proxy_wallet: r.proxyWallet,
            payload: r.payload,
          })),
          rowCount: out.length,
        };
      }

      if (sql.startsWith("UPDATE feed_trades")) {
        const [proxyWallet, payloadJson, tradeId] = values as [
          string | null,
          string,
          string,
          string,
        ];
        const row = store.get(tradeId.toLowerCase());
        if (!row) return { rows: [], rowCount: 0 };
        if (row.proxyWallet?.toLowerCase() !== D91_PROXY_WALLET) {
          return { rows: [], rowCount: 0 };
        }
        row.proxyWallet = proxyWallet;
        row.payload = JSON.parse(payloadJson);
        store.set(tradeId.toLowerCase(), row);
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

describe("d91FeedAttributionBackfill", () => {
  it("dry-run never issues UPDATE or transaction writes", async () => {
    const artifact = makeArtifact();
    const planEntries = buildPlanEntriesFromArtifact(artifact);
    const client = mockClient(d91Rows(artifact));

    const outcome = await executeD91FeedAttributionBackfill({
      client,
      artifact,
      planEntries,
      dryRun: true,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.dryRun) throw new Error("expected dry-run ok");
    expect(client.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
    expect(client.calls.some((c) => c.sql === "BEGIN")).toBe(false);
  });

  it("count mismatch aborts before writes", async () => {
    const artifact = makeArtifact({
      plan: {
        ...makeArtifact().plan,
        previouslyAttributedToD91: 111,
      },
    });
    const errors = validateArtifactPlanCounts(artifact);
    expect(errors.some((e) => e.includes("111"))).toBe(true);

    const planEntries = buildPlanEntriesFromArtifact(artifact);
    const client = mockClient(d91Rows(makeArtifact()));
    const outcome = await executeD91FeedAttributionBackfill({
      client,
      artifact,
      planEntries,
      dryRun: false,
    });
    expect(outcome.ok).toBe(false);
    expect(client.calls.some((c) => c.sql === "BEGIN")).toBe(false);
  });

  it("changed precondition aborts entire write", async () => {
    const artifact = makeArtifact();
    const planEntries = buildPlanEntriesFromArtifact(artifact);
    const rows = d91Rows(artifact);
    rows[0] = { ...rows[0], proxyWallet: "0xother0000000000000000000000000000000000001" };
    const client = mockClient(rows);

    const outcome = await executeD91FeedAttributionBackfill({
      client,
      artifact,
      planEntries,
      dryRun: false,
    });

    expect(outcome.ok).toBe(false);
    expect(client.calls.some((c) => c.sql === "BEGIN")).toBe(false);
    expect(client.calls.some((c) => c.sql === "COMMIT")).toBe(false);
  });

  it("rolls back when post-write verification fails", async () => {
    const artifact = makeArtifact();
    const planEntries = buildPlanEntriesFromArtifact(artifact);
    const client = mockClient(d91Rows(artifact));

    const outcome = await executeD91FeedAttributionBackfill({
      client,
      artifact,
      planEntries,
      dryRun: false,
      forcePostWriteVerificationFailure: true,
    });

    expect(outcome.ok).toBe(false);
    expect(client.calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(client.calls.some((c) => c.sql === "COMMIT")).toBe(false);
  });

  it("successful path applies 15 reattributions and 97 unresolved", async () => {
    const artifact = makeArtifact();
    const planEntries = buildPlanEntriesFromArtifact(artifact);
    const rows = d91Rows(artifact);
    const client = mockClient(rows);

    const outcome = await executeD91FeedAttributionBackfill({
      client,
      artifact,
      planEntries,
      dryRun: false,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.dryRun) throw new Error("expected execute ok");
    expect(outcome.result.verification.reattributed).toBe(
      D91_BACKFILL_INITIAL_SAFE_REATTRIBUTION,
    );
    expect(outcome.result.verification.unresolved).toBe(D91_BACKFILL_INITIAL_UNRESOLVED);
    expect(outcome.result.verification.d91Remaining).toBe(0);
    expect(client.calls.filter((c) => c.sql.startsWith("UPDATE")).length).toBe(
      D91_BACKFILL_EXPECTED_TOTAL,
    );
    expect(client.calls.some((c) => c.sql === "COMMIT")).toBe(true);
  });

  it("applyPlanToRows matches verifyPostWriteState for synthetic 112 rows", () => {
    const artifact = makeArtifact();
    const planEntries = buildPlanEntriesFromArtifact(artifact);
    const updated = applyPlanToRows(d91Rows(artifact), planEntries);
    const verification = verifyPostWriteState(updated, planEntries);
    expect(verification.ok).toBe(true);
  });

  it("loads frozen replay artifact and passes plan assertions when DB complete", () => {
    const artifactPath = join(process.cwd(), "tmp/d91-resolver-replay.json");
    let artifact: ReplayArtifact;
    try {
      artifact = loadD91ReplayArtifact(artifactPath);
    } catch {
      return;
    }

    const planErrors = validateArtifactPlanCounts(artifact);
    expect(planErrors).toEqual([]);

    const tradeIds = artifact.details.map((d) => d.tradeId.toLowerCase());
    const dbRows = tradeIds.map((tradeId) => ({
      tradeId,
      proxyWallet: D91_PROXY_WALLET,
      payload: { proxyWallet: D91_PROXY_WALLET },
    }));
    const report = buildAssertionReport(artifact, dbRows, tradeIds);
    expect(assertionsPass(report)).toBe(true);
    expect(report.unresolvedCount).toBe(97);
    expect(report.safeReattributionCount).toBe(15);
  });

  it("aborts when safe onchain-economic row has no_receipt evidence", () => {
    const artifact = makeArtifact();
    const badId = artifact.plan.backfillPlan.safelyReAttributable.tradeIds[0];
    for (const detail of artifact.details) {
      if (detail.tradeId === badId) {
        detail.economicReason = "no_receipt";
      }
    }
    const errors = validateSafeReattributionEvidence(artifact);
    expect(errors.length).toBeGreaterThan(0);
    expect(validateArtifactPlanCounts(artifact).length).toBeGreaterThan(0);
  });

  it("documents unresolved representation as NULL column without fake wallet", () => {
    expect(D91_UNRESOLVED_REPRESENTATION).toContain("NULL");
    expect(D91_UNRESOLVED_REPRESENTATION).not.toContain("0x000");
  });
});
