import assert from "node:assert/strict";
import {
  formatComboLegTitle,
  formatKalshiMarketDisplayTitle,
  humanizeKalshiTicker,
  isInternalKalshiTitle,
} from "./kalshiTitleResolver";

const MVE_TICKER =
  "KXMVESPORTSMULTIGAMEEXTENDED-S2026496DB6D909F-59E3FECD063";

assert.equal(
  isInternalKalshiTitle("Combo"),
  true,
  "generic Combo should be internal"
);
assert.equal(
  isInternalKalshiTitle("MVESPORTSMULTIGAMEEXTENDED"),
  true,
  "series code should be internal"
);
assert.equal(
  isInternalKalshiTitle(MVE_TICKER, MVE_TICKER),
  true,
  "raw ticker should be internal"
);
assert.equal(
  isInternalKalshiTitle(
    "yes Houston,no Over 7.5 runs scored,no Over 6.5 runs scored",
    MVE_TICKER
  ),
  false,
  "combo subtitle should be human-readable"
);

assert.equal(
  formatComboLegTitle(
    "yes Houston,no Over 7.5 runs scored,no Over 6.5 runs scored"
  ),
  "yes Houston, no Over 7.5 runs scored, no Over 6.5 runs scored"
);

assert.equal(
  formatKalshiMarketDisplayTitle(
    {
      ticker: MVE_TICKER,
      title: "yes Houston,no Over 7.5 runs scored,no Over 6.5 runs scored",
      yes_sub_title:
        "yes Houston,no Over 7.5 runs scored,no Over 6.5 runs scored",
      mve_selected_legs: [{}],
    },
    { title: "Combo", sub_title: "MVE" }
  ),
  "yes Houston, no Over 7.5 runs scored, no Over 6.5 runs scored"
);

assert.equal(
  formatKalshiMarketDisplayTitle(
    {
      ticker: "KXWNBASPREAD-26JUL22DALPDX-DAL5",
      title: "Dallas wins by over 4.5 points",
      yes_sub_title: "Dallas wins by over 4.5 points",
    },
    null
  ),
  "Dallas wins by over 4.5 points"
);

assert.equal(
  humanizeKalshiTicker(MVE_TICKER),
  "Sports Combo",
  "humanized MVE ticker should not expose raw series code"
);

console.log("✓ kalshiTitleResolver tests passed");
