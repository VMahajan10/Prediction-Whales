import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  listWalletDirectory,
  type WalletDirectorySort,
} from "@/lib/walletDirectory";
import type { ProfitFactorCategoryFilter } from "@/lib/walletProfitFactor";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minPfParam = searchParams.get("minPf");
  const minProfitFactor =
    minPfParam === null || minPfParam === ""
      ? 0
      : Number(minPfParam);
  const minPositionCount = Number(searchParams.get("minPositions") ?? "30");
  const category = (searchParams.get("category") ??
    "all") as ProfitFactorCategoryFilter;
  const sort = (searchParams.get("sort") ??
    "highest_profit_factor") as WalletDirectorySort;
  const limit = Number(searchParams.get("limit") ?? "40");

  try {
    const wallets = await listWalletDirectory({
      minProfitFactor: Number.isFinite(minProfitFactor) ? minProfitFactor : 0,
      minPositionCount: Number.isFinite(minPositionCount)
        ? minPositionCount
        : 30,
      category,
      sort,
      limit,
    });
    return NextResponse.json({ wallets });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to list wallets");
    console.error("[api/wallets/directory]", error);
    return NextResponse.json({ error: message, wallets: [] }, { status: 500 });
  }
}
