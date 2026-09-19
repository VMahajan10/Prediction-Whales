#!/usr/bin/env tsx
/**
 * Short smoke test: provider circuit open + idle must fail before wallet deadline.
 * Does not run Stage C cohort or touch the database.
 */
import { performance } from "node:perf_hooks";
import {
  EtherscanNoProgressTimeout,
  EtherscanProviderCircuitOpenError,
  ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON,
} from "@/lib/walletLedger/indexed/etherscanErrors";
import { EtherscanQueryController } from "@/lib/walletLedger/indexed/etherscanQueryController";
import {
  classifyExecutionOutcome,
  etherscanInfraTimeoutReason,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import {
  recordProviderFailure,
  resetProviderCircuitForTests,
} from "@/lib/walletLedger/indexed/shadow/providerCircuitBreaker";

async function smokeControllerCircuitIdle(): Promise<number> {
  resetProviderCircuitForTests();
  const started = performance.now();
  const controller = new EtherscanQueryController({
    wallet: "0xsmoke",
    queryIndex: 4,
    queryTotal: 11,
    queryLabel: "smoke",
    rangeFrom: 1,
    rangeTo: 2,
    noProgressTimeoutMs: 180_000,
    maxRuntimeMs: 3_600_000,
  });
  controller.start();
  controller.markProgress("page_processed", {
    requests: 12,
    pages: 12,
    logs: 9996,
  });
  for (let i = 0; i < 3; i += 1) {
    recordProviderFailure(new Error("transient"));
  }
  controller.setRuntimeState({
    limiterActive: 0,
    limiterWaiting: 0,
    providerCircuitOpen: true,
  });
  let error: unknown;
  try {
    controller.throwIfAborted();
  } catch (caught) {
    error = caught;
  }
  controller.stop();
  const elapsedMs = Math.round(performance.now() - started);
  if (!(error instanceof EtherscanProviderCircuitOpenError)) {
    throw new Error(`expected EtherscanProviderCircuitOpenError, got ${String(error)}`);
  }
  if (classifyExecutionOutcome(error) !== "deferred_infra") {
    throw new Error(`expected deferred_infra, got ${classifyExecutionOutcome(error)}`);
  }
  if (etherscanInfraTimeoutReason(error) !== ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON) {
    throw new Error(`unexpected reason ${etherscanInfraTimeoutReason(error)}`);
  }
  console.error(
    `[etherscan-circuit-smoke] controller idle circuit fail elapsedMs=${elapsedMs} reason=${ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON}`
  );
  return elapsedMs;
}

async function smokeNoProgressBeforeWalletDeadline(): Promise<number> {
  const started = performance.now();
  const controller = new EtherscanQueryController({
    wallet: "0xsmoke",
    queryIndex: 4,
    queryTotal: 11,
    queryLabel: "smoke",
    rangeFrom: 1,
    rangeTo: 2,
    noProgressTimeoutMs: 500,
    maxRuntimeMs: 3_600_000,
  });
  controller.start();
  controller.markProgress("page_processed", {
    requests: 12,
    pages: 12,
    logs: 9996,
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  controller.setRuntimeState({
    limiterActive: 0,
    limiterWaiting: 0,
    providerCircuitOpen: false,
  });
  let error: unknown;
  try {
    controller.throwIfAborted();
  } catch (caught) {
    error = caught;
  }
  controller.stop();
  const elapsedMs = Math.round(performance.now() - started);
  if (!(error instanceof EtherscanNoProgressTimeout)) {
    throw new Error(`expected EtherscanNoProgressTimeout, got ${String(error)}`);
  }
  if (elapsedMs >= 3_600_000) {
    throw new Error(`watchdog exceeded wallet deadline: ${elapsedMs}ms`);
  }
  console.error(
    `[etherscan-circuit-smoke] no-progress watchdog elapsedMs=${elapsedMs} (walletDeadlineMs=3600000)`
  );
  return elapsedMs;
}

async function main(): Promise<void> {
  const started = performance.now();
  const circuitMs = await smokeControllerCircuitIdle();
  const watchdogMs = await smokeNoProgressBeforeWalletDeadline();
  const totalMs = Math.round(performance.now() - started);
  console.error(
    `[etherscan-circuit-smoke] PASS totalMs=${totalMs} circuitIdleMs=${circuitMs} watchdogMs=${watchdogMs}`
  );
}

void main().catch((error) => {
  console.error("[etherscan-circuit-smoke] FAIL", error);
  process.exit(1);
});
