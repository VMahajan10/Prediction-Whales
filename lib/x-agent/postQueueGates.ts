/**
 * Hard-coded post-queue source gate — only Polymarket trades may proceed to
 * template generation and x_post_queue. Kalshi trades are tracked internally
 * via kalshi_shadow_trades and never queued for public X posting.
 */

export const KALSHI_PUBLIC_POSTING_DISABLED =
  "KALSHI_PUBLIC_POSTING_DISABLED" as const;

export type PostQueueSourceRejectionReason =
  typeof KALSHI_PUBLIC_POSTING_DISABLED;

export interface PostQueueSourceGateInput {
  source: "polymarket" | "kalshi";
  tradeId?: string;
}

export interface PostQueueSourceGateResult {
  passed: boolean;
  reason?: PostQueueSourceRejectionReason;
}

function gateLog(tradeId: string, message: string): void {
  console.log(`[Gate] tradeId=${tradeId} ${message}`);
}

export function logPostQueueSourceSkip(tradeId?: string): void {
  const message =
    "[Fail: Source] Kalshi public posting disabled (Polymarket required)";
  if (tradeId) {
    gateLog(tradeId, message);
    return;
  }
  console.log(message);
}

/** Returns true only for Polymarket-sourced trades. */
export function isPostQueueSourceAllowed(
  source: "polymarket" | "kalshi"
): boolean {
  return source === "polymarket";
}

/**
 * Step 0 — post-queue source gate. Kalshi trades short-circuit with
 * KALSHI_PUBLIC_POSTING_DISABLED before template generation or queuing.
 */
export function evaluatePostQueueSourceGate(
  input: PostQueueSourceGateInput
): PostQueueSourceGateResult {
  if (!isPostQueueSourceAllowed(input.source)) {
    logPostQueueSourceSkip(input.tradeId);
    return { passed: false, reason: KALSHI_PUBLIC_POSTING_DISABLED };
  }

  if (input.tradeId) {
    gateLog(input.tradeId, "[Pass: Source] Polymarket trade");
  }

  return { passed: true };
}
