import { NextRequest, NextResponse } from "next/server";
import { processWhaleTradeForXAgent } from "@/lib/x-agent/enqueueWhaleTrade";
import { notifyWhaleTradeIfEligible } from "@/lib/whaleTweetNotifier";
import type { WhaleTrade } from "@/lib/whaleTrades";

export const dynamic = "force-dynamic";

/**
 * Internal bridge for client-side whale watchers (WebSocket feed).
 * Validates payload shape, then triggers the secured tweet bot route server-side.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<WhaleTrade>;

    if (
      !body.id ||
      !body.title?.trim() ||
      body.usdNotional == null ||
      !Number.isFinite(body.usdNotional)
    ) {
      return NextResponse.json(
        { error: "Invalid whale trade payload" },
        { status: 400 }
      );
    }

    if (body.source === "kalshi") {
      return NextResponse.json({ ok: true, skipped: "kalshi_public_posting_disabled" });
    }

    notifyWhaleTradeIfEligible(body as WhaleTrade);
    void processWhaleTradeForXAgent(body as WhaleTrade).catch((error) => {
      console.error(
        "[api/whales/notify] x-agent enqueue failed",
        error instanceof Error ? error.message : error
      );
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(
      "[api/whales/notify]",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json({ error: "Failed to queue whale tweet" }, { status: 500 });
  }
}
