import { NextRequest, NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { resolveArbitrageDisplay } from "@/lib/arbitrageFinder/displayResolver";
import { parseStakeUsd } from "@/lib/arbitrageFinder/windowService";

export const dynamic = "force-dynamic";

function parseSource(
  raw: string | null
): "polymarket" | "kalshi" | "auto" | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "polymarket" || normalized === "pm") return "polymarket";
  if (normalized === "kalshi") return "kalshi";
  return "auto";
}

function parsePrefer(
  raw: string | null
): "auto" | "cross_venue" | "single_venue" | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "cross_venue" || normalized === "cross") {
    return "cross_venue";
  }
  if (normalized === "single_venue" || normalized === "single") {
    return "single_venue";
  }
  return "auto";
}

function parseTradePrice(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const pmTokenId =
      params.get("pmTokenId") ??
      params.get("tokenId") ??
      params.get("assetId");
    const kalshiTicker = params.get("kalshiTicker") ?? params.get("ticker");
    const tradeOutcomeSide = params.get("tradeOutcomeSide") ?? params.get("side");
    const tradePrice = parseTradePrice(
      params.get("tradePrice") ?? params.get("price")
    );
    const pmMid = parseTradePrice(params.get("pmMid"));

    if (!pmTokenId && !kalshiTicker) {
      return NextResponse.json(
        { error: "Provide pmTokenId and/or kalshiTicker", snapshot: null },
        { status: 400 }
      );
    }

    const snapshot = await resolveArbitrageDisplay({
      source: parseSource(params.get("source")),
      pmTokenId,
      kalshiTicker,
      tradeOutcomeSide,
      tradePrice,
      title: params.get("title"),
      slug: params.get("slug"),
      pmMid,
      stakeUsd: parseStakeUsd(params.get("stake") ?? params.get("stakeUsd")),
      prefer: parsePrefer(params.get("prefer")),
    });

    if (!snapshot) {
      return NextResponse.json({
        snapshot: null,
        error: "Unable to resolve arbitrage display for this market",
      });
    }

    return NextResponse.json({ snapshot });
  } catch (err) {
    const message = publicApiErrorMessage(err, "Arbitrage display failed");
    console.error("[api/arbitrage/display] GET failed:", err);
    return NextResponse.json({ error: message, snapshot: null }, { status: 500 });
  }
}
