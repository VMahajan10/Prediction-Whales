import { NextResponse } from "next/server";
import { resolveWalletForTrade } from "@/lib/resolveWhaleWallet";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hash = searchParams.get("hash");
  const assetId = searchParams.get("asset") ?? undefined;

  if (!hash) {
    return NextResponse.json(
      { error: "Missing hash parameter", wallet: null },
      { status: 400 }
    );
  }

  try {
    const { wallet, source } = await resolveWalletForTrade(hash, { assetId });
    return NextResponse.json({ wallet, source });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to resolve wallet";
    console.error("[api/wallet/resolve]", message);
    return NextResponse.json({ wallet: null, error: message }, { status: 500 });
  }
}
