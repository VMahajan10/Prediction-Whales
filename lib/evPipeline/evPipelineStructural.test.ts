import assert from "node:assert/strict";
import {
  classifyKalshiContract,
  classifyPmContract,
  contractsMappingCompatible,
  mappingCategoriesCompatible,
} from "./marketCategoryMatch";
import type { NormalizedMarketContract } from "./types";
import {
  resolvePmTokenOutcome,
} from "./exchangeConsensusArb";
import {
  probeMentionsTeamToken,
  resolveOutcomePmFromSuffix,
} from "./sportsSlugParse";

function pmContract(title: string, slug?: string): NormalizedMarketContract {
  return {
    platform: "polymarket",
    externalId: "cond-1",
    tokenOrTicker: "token-1",
    title,
    description: "",
    expiration: null,
    yesBid: 0.4,
    yesAsk: 0.42,
    spread: 0.02,
    impliedProbability: 0.41,
    embeddingText: title,
    slug: slug ?? null,
  };
}

function kalshiContract(ticker: string, title: string): NormalizedMarketContract {
  return {
    platform: "kalshi",
    externalId: ticker,
    tokenOrTicker: ticker,
    title,
    description: "",
    expiration: null,
    yesBid: 0.4,
    yesAsk: 0.42,
    spread: 0.02,
    impliedProbability: 0.41,
    embeddingText: title,
  };
}

assert.equal(
  mappingCategoriesCompatible("crypto", "macro"),
  false,
  "crypto must not match macro"
);
assert.equal(
  contractsMappingCompatible(
    pmContract("Will China invade Taiwan?"),
    kalshiContract("KXBTC-25DEC31", "Bitcoin above $100k")
  ),
  false,
  "geopolitics must not match crypto"
);
assert.equal(
  contractsMappingCompatible(
    pmContract("Will the Fed cut rates in March?"),
    kalshiContract("KXFED-25MAR", "Fed funds rate cut")
  ),
  true,
  "macro PM should match Fed Kalshi"
);
assert.equal(
  classifyKalshiContract(kalshiContract("KXBTC-25DEC31", "Bitcoin")),
  "crypto"
);
assert.equal(
  classifyPmContract(pmContract("How many tweets will Elon post?", "elon-tweets")),
  "culture"
);

assert.equal(
  resolveOutcomePmFromSuffix("draw", "lag", "stl"),
  "draw",
  "draw suffix must not map to lag via substring"
);
assert.equal(
  probeMentionsTeamToken("draw", "lag"),
  false,
  "draw must not mention lag team code"
);

const drawSlug = "mls-lag-stl-2026-07-22-draw";
const drawResolved = resolvePmTokenOutcome({
  slug: drawSlug,
  title: "LA Galaxy vs St. Louis City SC: Draw?",
  outcomeName: "Draw",
});
assert.equal(drawResolved?.outcome, "draw", "draw market should resolve to draw");

const binaryResolved = resolvePmTokenOutcome({
  slug: "will-china-invade-taiwan",
  title: "Will China invade Taiwan?",
  outcomeName: "Yes",
});
assert.equal(binaryResolved?.outcomePm, "yes", "binary yes outcome");
assert.equal(binaryResolved?.outcome, "team_a", "binary yes maps to team_a slot");

console.log("✓ ev pipeline structural fixes tests passed");
