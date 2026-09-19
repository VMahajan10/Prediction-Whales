#!/usr/bin/env tsx
import { WORKER_RESULT_PREFIX } from "@/lib/walletLedger/indexed/shadow/invocationSupervisor";
import {
  setAuditProgressEnabled,
  EtherscanProgressReporter,
  stopTrackedEtherscanProgress,
} from "@/lib/walletLedger/indexed/auditProgress";

const mode = process.env.SHADOW_SUPERVISOR_TEST_MODE ?? "complete_fast";

// tsx can exit before async main() settles; keep the event loop alive for hang modes.
const keepAlive = setInterval(() => {}, 60_000);

function emit(payload: Record<string, unknown>): void {
  console.log(`${WORKER_RESULT_PREFIX}${JSON.stringify(payload)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function blockSync(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Simulate non-cooperative CPU/sync work.
  }
}

async function main(): Promise<void> {
  if (mode === "complete_fast") {
    clearInterval(keepAlive);
    emit({ ok: true, wallet: "0xtest", status: "complete", row: { wallet: "0xtest", status: "complete" } });
    return;
  }

  if (mode === "hang_forever") {
    await new Promise(() => {
      // Never resolves.
    });
  }

  if (mode === "ignore_signal") {
    console.error("[test-worker] ignore_signal alive");
    process.on("SIGTERM", () => {
      console.error("[test-worker] ignoring SIGTERM");
    });
    process.on("SIGINT", () => {
      console.error("[test-worker] ignoring SIGINT");
    });
    // Async hang so SIGTERM handlers run; never resolves cooperatively.
    await new Promise(() => {});
  }

  if (mode === "block_event_loop") {
    console.error("[test-worker] block_event_loop alive");
    process.on("SIGTERM", () => {
      // Installed before the spin so Node queues SIGTERM instead of exiting,
      // but the handler cannot run while the event loop is starved.
    });
    const end = Date.now() + 600_000;
    while (Date.now() < end) {
      // Busy spin: queued SIGTERM/AbortSignal callbacks cannot run.
    }
    emit({ ok: true, wallet: "0xtest", status: "complete" });
    return;
  }

  if (mode === "block_persist") {
    await blockSync(600_000);
    emit({ ok: true, wallet: "0xtest", status: "complete" });
    return;
  }

  if (mode === "exceed_wallet_budget") {
    await sleep(600_000);
    emit({ ok: true, wallet: "0xtest", status: "complete" });
    return;
  }

  if (mode === "defer_orphan_heartbeat") {
    setAuditProgressEnabled(true);
    new EtherscanProgressReporter(11);
    emit({
      ok: true,
      wallet: "0xtest",
      status: "deferred_infra",
      row: { wallet: "0xtest", status: "deferred_infra" },
    });
    await new Promise(() => {});
  }

  if (mode === "defer_cleanup_exit") {
    setAuditProgressEnabled(true);
    const reporter = new EtherscanProgressReporter(11);
    emit({
      ok: true,
      wallet: "0xtest",
      status: "deferred_infra",
      row: { wallet: "0xtest", status: "deferred_infra" },
    });
    reporter.stop();
    stopTrackedEtherscanProgress();
    process.exit(0);
  }

  throw new Error(`unknown SHADOW_SUPERVISOR_TEST_MODE=${mode}`);
}

void main()
  .catch((error) => {
    emit({ ok: false, error: String(error) });
    process.exit(1);
  })
  .finally(() => {
    clearInterval(keepAlive);
  });
