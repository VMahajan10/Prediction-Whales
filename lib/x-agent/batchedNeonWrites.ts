import "server-only";

import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { xPostLog } from "@/lib/crossmarket/store/schema";
import type { TradePayload } from "@/lib/x-agent/gates";
import type { GateRejectionReason } from "@/lib/x-agent/gates";
import {
  flushKalshiShadowTradeBatch,
  KALSHI_SHADOW_FLUSH_INTERVAL_MS,
} from "@/lib/x-agent/kalshiShadowTrades";

/** Default Neon flush cadence for shadow ingestion batchers. */
export const NEON_BATCH_FLUSH_INTERVAL_MS = KALSHI_SHADOW_FLUSH_INTERVAL_MS;

type PendingGateLog = {
  tradeId: string;
  gatePassed: false;
  rejectionReason: GateRejectionReason;
  payload: TradePayload;
};

const pendingGateLogs: PendingGateLog[] = [];
let gateLogFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGateLogFlush(): void {
  if (gateLogFlushTimer) return;
  gateLogFlushTimer = setTimeout(() => {
    gateLogFlushTimer = null;
    void flushGateLogBatch();
  }, NEON_BATCH_FLUSH_INTERVAL_MS);
}

export function queueGateLogRejection(
  trade: TradePayload,
  reason: GateRejectionReason
): void {
  if (!isDatabaseEnabled()) return;

  pendingGateLogs.push({
    tradeId: trade.tradeId,
    gatePassed: false,
    rejectionReason: reason,
    payload: trade,
  });
  scheduleGateLogFlush();
}

export async function flushGateLogBatch(): Promise<void> {
  if (!isDatabaseEnabled() || pendingGateLogs.length === 0) return;

  const batch = pendingGateLogs.splice(0, pendingGateLogs.length);
  try {
    const db = getDb();
    await db.insert(xPostLog).values(
      batch.map((row) => ({
        tradeId: row.tradeId,
        gatePassed: row.gatePassed,
        rejectionReason: row.rejectionReason,
        payload: row.payload,
      }))
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[batchedNeonWrites] x_post_log batch insert failed (non-fatal) count=${batch.length}: ${message}`
    );
  }
}

export async function flushAllBatchedNeonWrites(): Promise<void> {
  if (gateLogFlushTimer) {
    clearTimeout(gateLogFlushTimer);
    gateLogFlushTimer = null;
  }

  await Promise.all([flushKalshiShadowTradeBatch(), flushGateLogBatch()]);
}
