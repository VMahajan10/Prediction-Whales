import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  recordFeedMetricsAndPersist,
  type FeedMetricsVenue,
} from "@/lib/feedMetrics";
import { getFeedDailyMetrics } from "@/lib/feedMetricsPersistence";

export const dynamic = "force-dynamic";

interface FeedMetricsBody {
  venue?: FeedMetricsVenue;
  tradesDetected?: number;
  gatePassedTrades?: number;
  whaleWallets?: string[];
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dayKey = searchParams.get("date") ?? searchParams.get("dayKey") ?? undefined;
    const venueParam = searchParams.get("venue");
    const venue =
      venueParam === "polymarket" || venueParam === "kalshi"
        ? venueParam
        : undefined;
    const fromDayKey = searchParams.get("from") ?? undefined;
    const toDayKey = searchParams.get("to") ?? undefined;

    const metrics = await getFeedDailyMetrics({
      dayKey,
      venue,
      fromDayKey,
      toDayKey,
    });

    return NextResponse.json({ ok: true, metrics });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to read feed metrics");
    console.error("[api/feed/metrics]", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as FeedMetricsBody;
    await recordFeedMetricsAndPersist({
      venue: body.venue ?? "polymarket",
      tradesDetected: body.tradesDetected,
      gatePassedTrades: body.gatePassedTrades,
      whaleWallets: body.whaleWallets,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to record feed metrics");
    console.error("[api/feed/metrics]", error);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
