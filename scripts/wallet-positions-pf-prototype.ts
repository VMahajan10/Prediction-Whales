#!/usr/bin/env tsx
/**
 * Prototype PF + net PnL from Polymarket positions + closed-positions APIs vs profile leaderboard.
 */
import "../tests/preload-env";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import { fetchClosedPositions } from "@/lib/polymarket";
import { isDatabaseEnabled, getDb } from "@/lib/crossmarket/store/db";
import { sql } from "drizzle-orm";
import { fetchWithTimeout as fetchPos } from "@/lib/fetchWithTimeout";

const WALLETS = [
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
  "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882",
  "0xad529df14c293d77984a0137990a1441b25211ac",
];

async function leaderboardPnl(wallet: string): Promise<number | null> {
  const res = await fetchWithTimeout(
    `https://data-api.polymarket.com/v1/leaderboard?user=${wallet}&timePeriod=all&orderBy=PNL&limit=1`,
    { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { pnl?: number }[];
  return typeof data[0]?.pnl === "number" ? data[0].pnl : null;
}

async function fetchAllPositions(wallet: string): Promise<
  {
    asset?: string;
    realizedPnl?: number;
    cashPnl?: number;
    size?: number;
    redeemable?: boolean;
    totalBought?: number;
  }[]
> {
  const rows: {
    asset?: string;
    realizedPnl?: number;
    cashPnl?: number;
    size?: number;
    redeemable?: boolean;
    totalBought?: number;
  }[] = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const res = await fetchPos(
      `https://data-api.polymarket.com/positions?user=${wallet}&limit=500&offset=${offset}`,
      { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
    );
    if (!res.ok) break;
    const page = (await res.json()) as typeof rows;
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

async function ledgerNetAndPf(wallet: string): Promise<{
  net: number;
  gp: number;
  gl: number;
  pf: number | null;
  n: number;
} | null> {
  if (!isDatabaseEnabled()) return null;
  const db = getDb();
  if (!db) return null;
  const r = await db.execute(sql`
    select
      sum(realized_pnl) filter (where completed and realized_pnl is not null) as net,
      sum(case when realized_pnl > 0 then realized_pnl else 0 end) filter (where completed) as gp,
      sum(case when realized_pnl < 0 then abs(realized_pnl) else 0 end) filter (where completed) as gl,
      count(*) filter (where completed and realized_pnl is not null) as n
    from wallet_position_lifecycles
    where lower(wallet_address) = lower(${wallet})
      and metric_version = 'phase2e1-v1'
  `);
  const row = r.rows[0] as {
    net: number;
    gp: number;
    gl: number;
    n: number;
  };
  const gp = Number(row.gp ?? 0);
  const gl = Number(row.gl ?? 0);
  const net = Number(row.net ?? 0);
  const n = Number(row.n ?? 0);
  return { net, gp, gl, pf: gl > 0 ? gp / gl : null, n };
}

function pfFromRealizedPnls(pnls: number[]): {
  grossProfit: number;
  grossLoss: number;
  net: number;
  pf: number | null;
  n: number;
} {
  let gp = 0;
  let gl = 0;
  for (const p of pnls) {
    if (p > 0) gp += p;
    else if (p < 0) gl += Math.abs(p);
  }
  return {
    grossProfit: gp,
    grossLoss: gl,
    net: gp - gl,
    pf: gl > 0 ? gp / gl : null,
    n: pnls.length,
  };
}

async function positionsApiPnls(wallet: string): Promise<{
  open: ReturnType<typeof pfFromRealizedPnls>;
  closed50: ReturnType<typeof pfFromRealizedPnls>;
  combinedUnique: ReturnType<typeof pfFromRealizedPnls>;
  openCount: number;
  closedCount: number;
}> {
  const [open, closed] = await Promise.all([
    fetchAllPositions(wallet),
    fetchClosedPositions(wallet),
  ]);

  const openPnls = open.map((p) => {
    const realized = Number(p.realizedPnl ?? 0);
    const size = Number(p.size ?? 0);
    if (size > 0.01 && p.redeemable) {
      return realized + Number(p.cashPnl ?? 0);
    }
    if (size <= 0.01) return realized;
    return realized;
  });

  const closedPnls = closed.map((p) => Number(p.realizedPnl ?? 0));

  const byAsset = new Map<string, number>();
  for (const p of open) {
    const a = p.asset?.trim();
    if (!a) continue;
    const realized = Number(p.realizedPnl ?? 0);
    const size = Number(p.size ?? 0);
    let v = realized;
    if (size > 0.01 && p.redeemable) v += Number(p.cashPnl ?? 0);
    byAsset.set(a, v);
  }
  for (const p of closed) {
    const a = String(p.asset ?? "").trim();
    if (!a) continue;
    byAsset.set(a, Number(p.realizedPnl ?? 0));
  }

  return {
    open: pfFromRealizedPnls(openPnls),
    closed50: pfFromRealizedPnls(closedPnls),
    combinedUnique: pfFromRealizedPnls([...byAsset.values()]),
    openCount: open.length,
    closedCount: closed.length,
  };
}

/** PF treating $0 realized on closed API rows as full loss of totalBought (loser at resolution). */
function pfClosedWithZeroLosers(
  closed: { realizedPnl?: number; totalBought?: number }[]
): ReturnType<typeof pfFromRealizedPnls> {
  const pnls: number[] = [];
  for (const p of closed) {
    const r = Number(p.realizedPnl ?? 0);
    const bought = Number(p.totalBought ?? 0);
    if (r === 0 && bought > 0) pnls.push(-bought);
    else pnls.push(r);
  }
  return pfFromRealizedPnls(pnls);
}

async function main() {
  console.log("PF prototype: positions API vs ledger vs profile\n");

  for (const wallet of WALLETS) {
    const profile = await leaderboardPnl(wallet);
    const api = await positionsApiPnls(wallet);
    const closed = await fetchClosedPositions(wallet);
    const zeroLossPf = pfClosedWithZeroLosers(closed);
    const ledger = await ledgerNetAndPf(wallet);

    const errLedger =
      profile != null && ledger?.net != null
        ? Math.abs(ledger.net - profile)
        : null;
    const errApiCombined =
      profile != null ? Math.abs(api.combinedUnique.net - profile) : null;
    const errApiClosed50 =
      profile != null ? Math.abs(api.closed50.net - profile) : null;

    console.log("=".repeat(60));
    console.log(wallet);
    console.log(`Profile PnL (leaderboard): $${profile?.toLocaleString() ?? "n/a"}`);
    console.log(
      `Ledger: net=$${ledger?.net?.toFixed(2) ?? "n/a"} PF=${ledger?.pf?.toFixed(2) ?? "n/a"} (${ledger?.n ?? 0} pos) |Δprofile|=$${errLedger?.toFixed(0) ?? "n/a"}`
    );
    console.log(
      `Positions open (${api.openCount}): net=$${api.open.net.toFixed(2)} PF=${api.open.pf?.toFixed(2) ?? "n/a"}`
    );
    console.log(
      `Closed-positions cap (${api.closedCount}): net=$${api.closed50.net.toFixed(2)} PF=${api.closed50.pf?.toFixed(2) ?? "n/a"} |Δprofile|=$${errApiClosed50?.toFixed(0) ?? "n/a"}`
    );
    console.log(
      `Closed 50 w/ $0→−totalBought losers: net=$${zeroLossPf.net.toFixed(2)} PF=${zeroLossPf.pf?.toFixed(2) ?? "n/a"} |Δprofile|=$${profile != null ? Math.abs(zeroLossPf.net - profile).toFixed(0) : "n/a"}`
    );
    console.log(
      `Union open+closed by asset: net=$${api.combinedUnique.net.toFixed(2)} PF=${api.combinedUnique.pf?.toFixed(2) ?? "n/a"} |Δprofile|=$${errApiCombined?.toFixed(0) ?? "n/a"}`
    );

    const winner =
      errLedger == null && errApiCombined == null
        ? "n/a"
        : errLedger != null &&
            (errApiCombined == null || errLedger <= errApiCombined)
          ? "ledger"
          : "positions_api_union";
    console.log(`Closer to profile (net): ${winner}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
