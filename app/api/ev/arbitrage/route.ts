import { NextRequest, NextResponse } from "next/server";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  scanArbitrageOpportunities,
  type ArbitrageOpportunity,
} from "@/lib/evPipeline/arbitrageScanner";
import {
  getMappingByKalshi,
  getMappingByPm,
} from "@/lib/evPipeline/redisCache";

export const dynamic = "force-dynamic";

function parseMappingPairKey(
  pairKey: string
): { polymarketTokenId: string; kalshiTicker: string } | null {
  const trimmed = pairKey.trim();
  const match = trimmed.match(/^pair:([^:]+):([^:]+)$/i);
  if (!match) return null;

  const polymarketTokenId = normalizePmTokenId(match[1]);
  const kalshiTicker = normalizeKalshiTicker(match[2]);
  if (!polymarketTokenId || !kalshiTicker) return null;

  return { polymarketTokenId, kalshiTicker };
}

function normalizePairKey(pairKey: string): string {
  const parsed = parseMappingPairKey(pairKey);
  if (!parsed) return pairKey.trim().toLowerCase();
  return pipelineMappingPairKey(
    parsed.polymarketTokenId,
    parsed.kalshiTicker
  );
}

export async function GET(request: NextRequest) {
  const pairKey = request.nextUrl.searchParams.get("pairKey")?.trim();
  if (!pairKey) {
    return NextResponse.json(
      { error: "Provide pairKey (e.g. pair:{pmToken}:{KALSHI_TICKER})" },
      { status: 400 }
    );
  }

  const parsed = parseMappingPairKey(pairKey);
  if (!parsed) {
    return NextResponse.json(
      { error: "Invalid pairKey format" },
      { status: 400 }
    );
  }

  try {
    const [pmMapping, kalshiMapping] = await Promise.all([
      getMappingByPm(parsed.polymarketTokenId),
      getMappingByKalshi(parsed.kalshiTicker),
    ]);
    const cached = pmMapping ?? kalshiMapping;

    const opportunities = await scanArbitrageOpportunities({
      mappings: [
        cached
          ? {
              polymarketTokenId: cached.polymarketTokenId.toLowerCase(),
              kalshiTicker: cached.kalshiTicker.toUpperCase(),
              orientation:
                cached.orientation === "inverted" ? "inverted" : "same",
              matchMethod: cached.matchMethod,
            }
          : {
              polymarketTokenId: parsed.polymarketTokenId,
              kalshiTicker: parsed.kalshiTicker,
              orientation: "same",
              matchMethod: "manual",
            },
      ],
    });

    const targetKey = normalizePairKey(pairKey);
    const alert: ArbitrageOpportunity | null =
      opportunities.find(
        (opportunity) =>
          opportunity.mappingPairKey.toLowerCase() === targetKey.toLowerCase()
      ) ?? null;

    return NextResponse.json(
      { pairKey: targetKey, alert, arbitrage: alert },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Arbitrage scan failed";
    console.error("[api/ev/arbitrage]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
