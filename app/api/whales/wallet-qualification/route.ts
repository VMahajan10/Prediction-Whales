import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
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
    const message = publicApiErrorMessage(
      error,
      "Failed to resolve wallet feed qualification"
    );
    console.error("[api/whales/wallet-qualification]", error);
    return NextResponse.json({ qualifications: {}, error: message }, { status: 500 });
  }
}
