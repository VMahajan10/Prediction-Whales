import { describe, expect, it } from "vitest";
import { InvocationBudget } from "@/lib/walletLedger/indexed/shadow/invocationBudget";
import {
  classifyMutuallyExclusiveBatchBucket,
  summarizeMutuallyExclusiveBatchBuckets,
} from "@/lib/walletLedger/indexed/shadow/stageCReconciliation";
import type { walletShadowBatchStatus } from "@/lib/crossmarket/store/schema";

type Row = typeof walletShadowBatchStatus.$inferSelect;

function statusRow(wallet: string, status: string): Row {
  return {
    batchId: "phase2e2-stageC-v1",
    walletAddress: wallet,
    status,
    cohortReason: "test",
    errorMessage: null,
    performance: null,
    updatedAt: new Date(),
  };
}

describe("invocation budget", () => {
  it("stops scheduling after max wallets", () => {
    const budget = new InvocationBudget(2, null);
    expect(budget.canScheduleNextWallet()).toBe(true);
    budget.markWalletScheduled();
    expect(budget.canScheduleNextWallet()).toBe(true);
    budget.markWalletScheduled();
    expect(budget.canScheduleNextWallet()).toBe(false);
    expect(budget.exhaustedReason()).toBe("invocation_wallet_budget_exhausted");
  });
});

describe("mutually exclusive batch buckets", () => {
  it("assigns each wallet to exactly one bucket summing to cohort size", () => {
    const wallets = ["0xaaa", "0xbbb", "0xccc", "0xddd", "0xeee"];
    const statusByWallet = new Map<string, Row>([
      ["0xaaa", statusRow("0xaaa", "complete")],
      ["0xbbb", statusRow("0xbbb", "unusable")],
      ["0xccc", statusRow("0xccc", "deferred_infra")],
      ["0xddd", statusRow("0xddd", "running")],
    ]);
    const buckets = summarizeMutuallyExclusiveBatchBuckets(wallets, statusByWallet);
    const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
    expect(sum).toBe(5);
    expect(buckets.never_attempted).toBe(1);
    expect(buckets.complete).toBe(1);
    expect(buckets.unusable).toBe(1);
    expect(buckets.deferred_infra).toBe(1);
    expect(buckets.running).toBe(1);
    expect(classifyMutuallyExclusiveBatchBucket(undefined)).toBe(
      "never_attempted"
    );
  });
});
