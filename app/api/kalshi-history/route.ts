import { getHistory } from "@/lib/kalshiPriceStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");

  if (!ticker) {
    return NextResponse.json(
      { history: [], error: "ticker required" },
      { status: 400 }
    );
  }

  const history = await getHistory(ticker);
  return NextResponse.json({ history });
}
