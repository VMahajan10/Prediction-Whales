import { NextRequest, NextResponse } from "next/server";
import { loadPipelineTraderEvAnalytics } from "@/lib/evPipeline/traderEvLookup";
import type { TraderEvPeriod, TraderEvPlatform } from "@/lib/crossmarket/store/schema";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet")?.toLowerCase();

  if (!wallet) {
    return NextResponse.json(
      { error: "Provide wallet query parameter" },
      { status: 400 }
    );
  }

  const platform = (searchParams.get("platform") ??
    "polymarket") as TraderEvPlatform;
  const period = (searchParams.get("period") ?? "live") as TraderEvPeriod;

  const analytics = await loadPipelineTraderEvAnalytics(wallet, platform, period);

  return NextResponse.json({
    wallet,
    analytics,
    resolved: analytics != null,
  });
}
