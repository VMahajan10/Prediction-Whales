import { NextResponse } from "next/server";
import { recordFeedMetrics } from "@/lib/feedMetrics";

export const dynamic = "force-dynamic";

interface FeedMetricsBody {
  tradesDetected?: number;
  gatePassedTrades?: number;
  whaleWallets?: string[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as FeedMetricsBody;
    recordFeedMetrics({
      tradesDetected: body.tradesDetected,
      gatePassedTrades: body.gatePassedTrades,
      whaleWallets: body.whaleWallets,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to record feed metrics";
    console.error("[api/feed/metrics]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
