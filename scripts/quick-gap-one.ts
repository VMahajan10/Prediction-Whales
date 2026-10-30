#!/usr/bin/env tsx
import "../tests/preload-env";
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";
import {
  summarizeResolvedOpenRedeemable,
  sumReconciliationPnl,
  sumReconciliationPnlAvoidDoubleCount,
} from "@/lib/polymarketDataApi/positionPnlRollup";
import {
  reconciliationGapPercent,
  reconciliationPasses,
} from "@/lib/polymarketDataApi/reconciliation";
import { fetchV2HeadlineRealizedPnl } from "@/lib/polymarketDataApi/userPnl";

const W = process.argv[2];
if (!W) process.exit(1);

async function main() {
  const closed = await fetchAllV2PositionsForStatus(W, "CLOSED");
  const open = await fetchAllV2PositionsForStatus(W, "OPEN");
  const red = await fetchAllV2PositionsForStatus(W, "REDEEMABLE");
  const all = [...closed, ...open, ...red];
  const headline = await fetchV2HeadlineRealizedPnl(W);
  const old = closed.reduce((s, r) => s + Number(r.realized_pnl || 0), 0);
  const neu = sumReconciliationPnl(all);
  const neuDc = sumReconciliationPnlAvoidDoubleCount(all);
  const s = summarizeResolvedOpenRedeemable([...open, ...red]);
  const oldGap = headline != null ? reconciliationGapPercent(old, headline) : null;
  const newGap = headline != null ? reconciliationGapPercent(neu, headline) : null;
  const newGapDc =
    headline != null ? reconciliationGapPercent(neuDc, headline) : null;
  console.log({
    closed: closed.length,
    open: open.length,
    redeemable: red.length,
    resolvedOpenRedeemable: s,
    old,
    neu,
    neuDc,
    headline,
    oldGap,
    newGap,
    newGapDc,
    oldPass: reconciliationPasses(oldGap),
    newPass: reconciliationPasses(newGap),
    newPassDc: reconciliationPasses(newGapDc),
  });
}

main();
