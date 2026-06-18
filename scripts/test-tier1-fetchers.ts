/**
 * Live smoke test for Tier-1 platform fetchers (STEP 3).
 * Usage: npx tsx scripts/test-tier1-fetchers.ts
 */
import { fetchKalshiRawMarkets } from "../lib/crossmarket/platforms/kalshi";
import { fetchManifoldRawMarkets } from "../lib/crossmarket/platforms/manifold";
import { fetchMetaculusRawMarkets } from "../lib/crossmarket/platforms/metaculus";
import { PLATFORM_REGISTRY } from "../lib/crossmarket/platforms/registry";

function sampleRows<T>(rows: T[], n = 3): T[] {
  return rows.slice(0, n);
}

function printSamples(
  platform: string,
  rows: Array<{
    external_id: string;
    title: string;
    yes_price: number | null;
    volume: number | null;
    url: string | null;
    yes_price_kind?: string;
    _mapping?: Record<string, string>;
  }>
) {
  console.log(`\n=== ${platform} (${rows.length} samples) ===`);
  console.log(`Registry: ${PLATFORM_REGISTRY[platform as keyof typeof PLATFORM_REGISTRY]?.priceNote ?? ""}`);
  for (const r of rows) {
    console.log(JSON.stringify({
      external_id: r.external_id,
      title: r.title.slice(0, 80),
      yes_price: r.yes_price,
      yes_price_kind: r.yes_price_kind,
      volume: r.volume,
      url: r.url,
      field_mapping: r._mapping,
    }, null, 2));
  }
}

async function main() {
  console.log("Fetching Tier-1 platforms (live APIs)...\n");

  const [kalshi, manifold, metaculus] = await Promise.all([
    fetchKalshiRawMarkets(),
    fetchManifoldRawMarkets(),
    fetchMetaculusRawMarkets(),
  ]);

  console.log(`Counts: kalshi=${kalshi.length} manifold=${manifold.length} metaculus=${metaculus.length}`);

  const kalshiWithPrice = kalshi.filter((m) => m.yes_price != null);
  printSamples(
    "kalshi",
    sampleRows(kalshiWithPrice.length ? kalshiWithPrice : kalshi).map((m) => ({
      ...m,
      _mapping: {
        yes_price: "midpoint(yes_bid_dollars, yes_ask_dollars) when both > 0",
        volume: "volume_fp",
      },
    }))
  );

  const manifoldBinary = manifold.filter(
    (m) => m.raw_payload.outcomeType === "BINARY" && m.yes_price != null
  );
  printSamples(
    "manifold",
    sampleRows(manifoldBinary.length ? manifoldBinary : manifold).map((m) => ({
      ...m,
      _mapping: {
        yes_price: "probability (BINARY only; not internal p=0.5 prior)",
        volume: "volume (total MANA traded)",
      },
    }))
  );

  if (metaculus.length === 0) {
    console.log("\n=== metaculus (0 rows) ===");
    console.log(
      "METACULUS_API_TOKEN not set or API returned no open questions."
    );
    console.log("Field mapping (when token present):");
    console.log(
      JSON.stringify(
        {
          yes_price:
            "community_prediction.full.q2 (community median forecast — NOT tradeable)",
          yes_price_kind: "forecast_consensus",
          volume: "number_of_predictions (forecaster count, not dollar volume)",
        },
        null,
        2
      )
    );
  } else {
    printSamples(
      "metaculus",
      sampleRows(metaculus).map((m) => ({
        ...m,
        _mapping: {
          yes_price: "community_prediction.full.q2",
          volume: "number_of_predictions",
        },
      }))
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
