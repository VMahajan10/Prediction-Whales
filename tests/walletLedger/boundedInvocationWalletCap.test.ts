import { describe, expect, it } from "vitest";
import type { ShadowCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohort";
import { runBoundedShadowInvocation } from "@/lib/walletLedger/indexed/shadow/boundedInvocationRunner";
import type {
  SuperviseChildProcessInput,
  SupervisedWorkerResult,
} from "@/lib/walletLedger/indexed/shadow/invocationSupervisor";

function spec(wallet: string): ShadowCohortWallet {
  return { wallet, label: wallet.slice(0, 8), cohortReason: "test" };
}

describe("bounded invocation wallet cap", () => {
  it("never spawns wallet 11 when invocation max wallets is 10", async () => {
    const spawned: string[] = [];
    const superviseChild = async (
      input: SuperviseChildProcessInput
    ): Promise<SupervisedWorkerResult> => {
      const walletArg = input.args.find((arg) => arg.endsWith(".json"));
      spawned.push(walletArg ?? "unknown");
      return {
        ok: true,
        exitCode: 0,
        signal: null,
        stopReason: "completed",
        payload: {
          ok: true,
          status: "complete",
          row: {
            wallet: "0xtest",
            label: "test",
            cohortReason: "test",
            productionDecision: null,
            apiReconstructedDecision: null,
            indexedDecision: false,
            productionCredible: null,
            indexedCredible: false,
            productionAgreement: false,
            apiAgreement: false,
            agreement: false,
            primaryReason: "other",
            productionReasons: ["other"],
            apiReasons: ["other"],
            reasons: ["other"],
            evidence: {},
            historyValidity: "usable",
            historyComplete: true,
            credibilityMetricsValid: true,
            status: "complete",
          },
        },
        wallMs: 1,
        stdout: "",
        stderr: "",
        gracefulShutdownRequested: false,
        forcedKill: false,
        childPid: 1,
      };
    };

    const pending = Array.from({ length: 15 }, (_, index) =>
      spec(`0x${(index + 1).toString(16).padStart(40, "0")}`)
    );

    const result = await runBoundedShadowInvocation({
      batchId: "bounded-cap-test",
      pending,
      fullHistory: true,
      enableWalletRuntimeBudget: false,
      invocationMaxWallets: 10,
      invocationMaxRuntimeMs: null,
      superviseChild,
    });

    expect(spawned).toHaveLength(10);
    expect(result.invocationBudget.walletsStarted).toBe(10);
    expect(result.rows).toHaveLength(10);
    expect(result.infraInterrupted).toBe(true);
  });
});
