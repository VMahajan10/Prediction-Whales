import { dataApiGetJson } from "@/lib/polymarketDataApi/http";
import type { V2UserPnlResponse } from "@/lib/polymarketDataApi/types";

export async function fetchV2HeadlineRealizedPnl(
  wallet: string
): Promise<number | null> {
  const res = await dataApiGetJson<V2UserPnlResponse>("/v2/user-pnl", {
    user: wallet.toLowerCase(),
    interval: "max",
    fidelity: "1d",
  });
  const points = res.data?.points;
  if (!points?.length) return null;
  const latest = points[points.length - 1];
  const pnl =
    latest.realized_pnl ?? latest.realized_market_pnl ?? latest.position_pnl;
  return typeof pnl === "number" && Number.isFinite(pnl) ? pnl : null;
}
