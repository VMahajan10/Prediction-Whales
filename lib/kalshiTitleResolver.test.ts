import assert from "node:assert/strict";
import {
  dedupeComboLegTitles,
  formatComboLegTitle,
  formatKalshiMarketDisplayTitle,
  humanizeKalshiTicker,
  isInternalKalshiTitle,
  resolveKalshiMarketTitleParts,
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
  dedupeComboLegTitles(
    "yes Over 7.5 runs scored, yes Over 6.5 runs scored"
  ),
  "Over 7.5 runs scored · Over 6.5 runs scored"
);

const tennisParts = resolveKalshiMarketTitleParts(
  {
    ticker: "KXITFMATCH-EXAMPLE",
    title: "Stefanos Tsitsipas",
    yes_sub_title: "STEFANOS TSITSIPAS",
  },
  { title: "Stefanos Tsitsipas vs Joao Fonseca" }
);
assert.equal(
  tennisParts.eventTitle,
  "Stefanos Tsitsipas vs Joao Fonseca",
  "event title should be parent matchup"
);
assert.equal(
  tennisParts.contractLabel,
  "Stefanos Tsitsipas",
  "contract label should be player selection"
);

const comboParts = resolveKalshiMarketTitleParts(
  {
    ticker: MVE_TICKER,
    title: "yes Houston,no Over 7.5 runs scored,no Over 6.5 runs scored",
    yes_sub_title:
      "yes Houston,no Over 7.5 runs scored,no Over 6.5 runs scored",
    mve_selected_legs: [{}],
  },
  { title: "Combo", sub_title: "MVE" }
);
assert.equal(comboParts.eventTitle, "Sports Combo");
assert.equal(
  comboParts.contractLabel,
  "Houston · Over 7.5 runs scored · Over 6.5 runs scored"
);

assert.equal(
  formatKalshiMarketDisplayTitle(
    {
      ticker: "KXWNBASPREAD-26JUL22DALPDX-DAL5",
      title: "Dallas wins by over 4.5 points",
      yes_sub_title: "Dallas wins by over 4.5 points",
    },
    { title: "Dallas at Portland" }
  ),
  "Dallas at Portland"
);

assert.equal(
  humanizeKalshiTicker(MVE_TICKER),
  "Sports Combo",
  "humanized MVE ticker should not expose raw series code"
);

console.log("✓ kalshiTitleResolver tests passed");
