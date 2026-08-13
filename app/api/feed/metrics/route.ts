import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
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
    const message = publicApiErrorMessage(error, "Failed to record feed metrics");
    console.error("[api/feed/metrics]", error);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
