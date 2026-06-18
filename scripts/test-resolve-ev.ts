import { buildCrossMarketBookIndex } from "../lib/crossMarketEv";
import { resolveCrossMarketEvForTrade } from "../lib/resolveTradeCrossMarketEv";

async function main() {
  const index = await buildCrossMarketBookIndex();
  const r = resolveCrossMarketEvForTrade(
    {
      source: "polymarket",
      price: 0.59,
      slug: "fifwc-gha-pan-2026-06-17-pan",
    },
    index
  );
  console.log(JSON.stringify(r, null, 2));
}

main().catch(console.error);
