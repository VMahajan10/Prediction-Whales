import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";

export async function fetchPolymarketProfilePnl(wallet: string): Promise<{
  source: string;
  pnl: number | null;
  raw?: unknown;
}> {
  const w = wallet.toLowerCase();
  const attempts: { url: string; label: string }[] = [
    {
      url: `https://data-api.polymarket.com/v1/leaderboard?window=all&limit=1000`,
      label: "leaderboard_all_1000",
    },
    {
      url: `https://data-api.polymarket.com/v1/leaderboard?window=all&limit=5000`,
      label: "leaderboard_all_5000",
    },
    {
      url: `https://gamma-api.polymarket.com/public-profile?address=${w}`,
      label: "gamma_public_profile",
    },
    {
      url: `https://data-api.polymarket.com/profile?user=${w}`,
      label: "data_api_profile_user",
    },
    {
      url: `https://data-api.polymarket.com/profile?address=${w}`,
      label: "data_api_profile_address",
    },
  ];

  for (const { url, label } of attempts) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: mergeOutboundHeaders({ Accept: "application/json" }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (label.startsWith("leaderboard")) {
        const rows = Array.isArray(data) ? data : [];
        const row = rows.find(
          (r: { proxyWallet?: string }) =>
            r.proxyWallet?.toLowerCase() === w
        );
        if (row && typeof row.pnl === "number") {
          return { source: label, pnl: row.pnl, raw: row };
        }
        continue;
      }
      if (data && typeof data === "object") {
        const pnl =
          (data as { pnl?: number }).pnl ??
          (data as { profit?: number }).profit ??
          (data as { totalPnl?: number }).totalPnl;
        if (typeof pnl === "number") {
          return { source: label, pnl, raw: data };
        }
      }
    } catch {
      continue;
    }
  }
  return { source: "not_found", pnl: null };
}
