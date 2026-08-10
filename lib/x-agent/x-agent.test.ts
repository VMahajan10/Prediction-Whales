import assert from "node:assert/strict";
import { calculateAvgEv, formatEvGloss } from "./math";
import { buildReviewActionLinks } from "./notifications";
import { computeApprovalScheduledFor } from "./reviewDb";
import {
  generateXPostCopy,
  sanitizeXPostCopy,
} from "./templates";
import { PostTemplateError } from "@/lib/templates/postTemplates";
import { translateMarketAndSide } from "./translator";

assert.equal(
  calculateAvgEv([
    { payout: 1.2, entryPrice: 1 },
    { payout: 0.8, entryPrice: 1 },
  ]),
  0,
  "balanced resolved bets average to 0 EV"
);

assert.equal(
  calculateAvgEv([{ payout: 1.5, entryPrice: 1 }]),
  0.5,
  "single winning bet EV"
);

assert.equal(
  formatEvGloss(0.12, () => 0),
  "profitable on average",
  "formatEvGloss uses rng"
);

assert.equal(
  translateMarketAndSide({
    source: "kalshi",
    title: "Bitcoin above 100k",
    outcome: "Yes",
    side: "BUY",
  }),
  null,
  "non-polymarket source fails closed"
);

assert.deepEqual(
  translateMarketAndSide({
    source: "polymarket",
    title: "Will China invade Taiwan?",
    outcome: "Yes",
    side: "BUY",
  }),
  {
    side: "China invade Taiwan",
    marketPlain: "China invade Taiwan",
  }
);

assert.equal(
  translateMarketAndSide({
    source: "polymarket",
    title: "Spain vs Portugal",
    outcome: "prt",
    side: "BUY",
    slug: "fifwc-prt-esp-2026-07-22-prt",
  })?.side,
  "Portugal",
  "PM team codes map to country names"
);

assert.equal(
  translateMarketAndSide({
    source: "polymarket",
    title: "LA Galaxy vs St. Louis",
    outcome: "lag",
    side: "BUY",
    slug: "mls-lag-stl-2026-07-22-lag",
  }),
  null,
  "opaque club tickers fail closed"
);

assert.throws(
  () =>
    generateXPostCopy({
      whale: "",
      side: "bought yes",
      entry: 35,
      avg_ev: 0.08,
      marketPlain: "China invade Taiwan",
      stakeNotional: 30_000,
    }),
  PostTemplateError,
  "missing whale fails closed"
);

const contrarian = generateXPostCopy(
  {
    whale: "DeepWallet",
    side: "buy yes",
    entry: 35,
    now: 42,
    avg_ev: 0.08,
    marketPlain: "China invade Taiwan",
    stakeNotional: 30_000,
    postedCount30d: 0,
    resolvedBetsCount: 512,
    winRate: 0.61,
  },
  undefined,
  () => 0
);
assert.equal(contrarian.family, "V5", "entry below 40c with moved line selects V5");
assert.ok(!contrarian.copyText.includes("🚨"));
assert.ok(!contrarian.copyText.includes("http"));

const moved = generateXPostCopy(
  {
    whale: "DeepWallet",
    side: "buy yes",
    entry: 52,
    now: 58,
    avg_ev: 0.08,
    marketPlain: "Fed rate cut in March",
    stakeNotional: 30_000,
    avgStakeNotional: 20_000,
    postedCount30d: 3,
    resolvedBetsCount: 512,
    winRate: 0.61,
  },
  "V6"
);
assert.equal(moved.family, "V3", "line move picks V3 when V5/V7 ineligible and V6 excluded");
assert.ok(
  moved.copyText.includes("58¢") &&
    (moved.copyText.includes("Now:") ||
      moved.copyText.includes("already") ||
      moved.copyText.includes("now")),
  "line move copy references current price"
);

assert.equal(
  sanitizeXPostCopy("Check https://evil.com now #WhaleTracker #crypto"),
  "Check now #WhaleTracker"
);

const links = buildReviewActionLinks("tok-123", "https://your-domain.com");
assert.ok(links.approve.includes("action=approve"));
assert.ok(links.kill.includes("action=kill"));
assert.ok(links.edit.endsWith("/api/x-agent/review/edit?token=tok-123"));

const scheduled = computeApprovalScheduledFor(() => 0);
const deltaMin = (scheduled.getTime() - Date.now()) / 60_000;
assert.ok(deltaMin >= 14 && deltaMin <= 16, "approval jitter starts at 15 minutes");

console.log("✓ x-agent tests passed");
