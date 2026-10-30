import assert from "node:assert/strict";
import {
  reconciliationGapPercent,
  reconciliationPasses,
} from "@/lib/polymarketDataApi/reconciliation";

assert.equal(reconciliationGapPercent(46377, 43378)?.toFixed(2), "6.91");
assert.equal(reconciliationPasses(6.91), true);
assert.equal(reconciliationPasses(11), false);
assert.equal(reconciliationGapPercent(100, 0), null);

console.log("reconciliation tests passed");
