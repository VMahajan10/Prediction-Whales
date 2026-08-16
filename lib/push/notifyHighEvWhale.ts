import "server-only";

import { sendPushToAllDevices } from "@/lib/push/sendPush";
import {
  buildWhalePushPayload,
  shouldSendHighEvWhalePush,
} from "@/lib/push/highEvWhalePushLogic";
import { whaleTradeDedupKey } from "@/lib/whaleTweetNotifier";
import type { WhaleTrade } from "@/lib/whaleTrades";

const pushedTradeKeys = new Set<string>();

/**
 * Send a native push when a live whale trade clears product feed EV gates.
 * Dedupes per process lifetime (same pattern as tweet notifier).
 */
export async function notifyHighEvWhalePush(trade: WhaleTrade): Promise<void> {
  if (!shouldSendHighEvWhalePush(trade)) return;

  const key = whaleTradeDedupKey(trade);
  if (pushedTradeKeys.has(key)) return;
  pushedTradeKeys.add(key);

  await sendPushToAllDevices(buildWhalePushPayload(trade));
}
