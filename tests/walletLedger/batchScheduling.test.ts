import { describe, expect, it } from "vitest";
import {
  bucketResumableWallets,
  isDeferRetryBudgetExhausted,
  scheduleResumableWallets,
  summarizeCohortScheduling,
} from "@/lib/walletLedger/indexed/shadow/batchScheduling";
import type { ShadowCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohort";
import type { walletShadowBatchStatus } from "@/lib/crossmarket/store/schema";

function spec(wallet: string): ShadowCohortWallet {
  return { wallet, label: wallet.slice(0, 8), cohortReason: "test" };
}

function row(
  wallet: string,
  status: string,
  performance?: Record<string, unknown>
): Row {
  return {
    batchId: "phase2e2-stageC-v1",
    walletAddress: wallet,
    status,
    cohortReason: "test",
    errorMessage: null,
    performance: performance ?? null,
    updatedAt: new Date(),
    createdAt: new Date(),
  };
}

describe("batch scheduling", () => {
  it("schedules never-attempted wallets before deferred retries", () => {
    const cohort = [spec("0xaaa"), spec("0xbbb"), spec("0xccc"), spec("0xddd")];
    const statusByWallet = new Map<string, Row>([
      ["0xaaa", row("0xaaa", "deferred_infra", { deferAttempts: 1 })],
      ["0xbbb", row("0xbbb", "complete")],
    ]);
    const scheduled = scheduleResumableWallets(cohort, statusByWallet);
    expect(scheduled.map((w) => w.wallet)).toEqual(["0xccc", "0xddd", "0xaaa"]);
  });

  it("passA schedules only never-attempted wallets", () => {
    const cohort = [spec("0xaaa"), spec("0xbbb"), spec("0xccc"), spec("0xddd")];
    const statusByWallet = new Map<string, Row>([
      ["0xaaa", row("0xaaa", "deferred_infra", { deferAttempts: 1 })],
      ["0xbbb", row("0xbbb", "complete")],
    ]);
    expect(
      scheduleResumableWallets(cohort, statusByWallet, "passA").map((w) => w.wallet)
    ).toEqual(["0xccc", "0xddd"]);
  });

  it("passB schedules only deferred retries", () => {
    const cohort = [spec("0xaaa"), spec("0xbbb"), spec("0xccc")];
    const statusByWallet = new Map<string, Row>([
      ["0xaaa", row("0xaaa", "deferred_infra", { deferAttempts: 1 })],
      ["0xbbb", row("0xbbb", "complete")],
    ]);
    expect(
      scheduleResumableWallets(cohort, statusByWallet, "passB").map((w) => w.wallet)
    ).toEqual(["0xaaa"]);
  });

  it("excludes exhausted deferred wallets from all passes", () => {
    const cohort = [spec("0xaaa"), spec("0xbbb")];
    const statusByWallet = new Map<string, Row>([
      ["0xaaa", row("0xaaa", "deferred_infra", { deferAttempts: 3 })],
      ["0xbbb", row("0xbbb", "deferred_infra", { deferAttempts: 1 })],
    ]);
    const buckets = bucketResumableWallets(cohort, statusByWallet);
    expect(buckets.deferredExhausted).toEqual(["0xaaa"]);
    expect(buckets.deferredRetryable.map((w) => w.wallet)).toEqual(["0xbbb"]);
    expect(isDeferRetryBudgetExhausted(statusByWallet.get("0xaaa"))).toBe(true);
  });

  it("marks batch conclusion ready only when all wallets are terminal or exhausted", () => {
    const cohort = [spec("0xaaa"), spec("0xbbb"), spec("0xccc")];
    const pending = new Map<string, Row>([
      ["0xaaa", row("0xaaa", "complete")],
      ["0xbbb", row("0xbbb", "deferred_infra", { deferAttempts: 3 })],
      ["0xccc", row("0xccc", "unusable")],
    ]);
    expect(summarizeCohortScheduling(cohort, pending).batchConclusionReady).toBe(
      true
    );

    const incomplete = new Map<string, Row>([
      ["0xaaa", row("0xaaa", "complete")],
      ["0xbbb", row("0xbbb", "deferred_infra", { deferAttempts: 1 })],
    ]);
    expect(
      summarizeCohortScheduling(cohort, incomplete).batchConclusionReady
    ).toBe(false);
  });
});
