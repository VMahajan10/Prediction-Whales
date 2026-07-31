import { NextResponse } from "next/server";
import { qualifyWalletsForFeed } from "@/lib/feedQualificationServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { wallets?: string[] };
    const wallets = Array.isArray(body.wallets) ? body.wallets : [];
    const qualifications = await qualifyWalletsForFeed(wallets);
    return NextResponse.json({ qualifications });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to resolve wallet feed qualification";
    console.error("[api/whales/wallet-qualification]", message);
    return NextResponse.json({ qualifications: {}, error: message }, { status: 500 });
  }
}
