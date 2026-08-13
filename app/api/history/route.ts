import { NextRequest, NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const tokenId = request.nextUrl.searchParams.get("tokenId");

  if (!tokenId) {
    return NextResponse.json(
      { history: [], error: "tokenId required" },
      { status: 400 }
    );
  }

  try {
    const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=1h&fidelity=60`;
    const res = await fetch(url, { next: { revalidate: 0 } });
    const data = await res.json();
    return NextResponse.json({ history: data.history ?? [] });
  } catch (err) {
    console.error("[api/history]", err);
    return NextResponse.json(
      {
        history: [],
        error: publicApiErrorMessage(err, "Failed to load price history"),
      },
      { status: 500 }
    );
  }
}
