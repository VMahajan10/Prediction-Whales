import assert from "node:assert/strict";
import {
  buildWhalePushPayload,
  shouldSendHighEvWhalePush,
} from "@/lib/push/highEvWhalePushLogic";
import type { WhaleTrade } from "@/lib/whaleTrades";

const baseTrade: WhaleTrade = {
  id: "trade-1",
  title: "Will BTC hit $100k?",
  side: "BUY",
  outcome: "Yes",
  price: 0.42,
  size: 1000,
  usdNotional: 1200,
  timestamp: Math.floor(Date.now() / 1000),
  transactionHash: "0xabc",
  detectedAt: Date.now(),
  isLive: true,
  source: "polymarket",
  netEvPercent: 4.2,
};

function run(): void {
  assert.equal(shouldSendHighEvWhalePush(baseTrade), true);

  const payload = buildWhalePushPayload(baseTrade);
  assert.match(payload.title, /High-EV whale trade/);
  assert.match(payload.body, /Will BTC hit \$100k\?/);
  assert.equal(payload.data.path, "/whales/0xabc");

  assert.equal(
    shouldSendHighEvWhalePush({
      ...baseTrade,
      netEvPercent: 1.5,
    }),
    false
  );

  console.log("✓ push notification helpers");
}

run();
