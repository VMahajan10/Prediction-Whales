#!/usr/bin/env tsx
import "../tests/preload-env";
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";

const W3 = "0xad529df14c293d77984a0137990a1441b25211ac";

async function main() {
  const closed = await fetchAllV2PositionsForStatus(W3, "CLOSED");
  let w = 0;
  let l = 0;
  let z = 0;
  for (const r of closed) {
    const p = Number(r.realized_pnl ?? 0);
    if (p > 0) w++;
    else if (p < 0) l++;
    else z++;
  }
  const correct = (w / (w + l)) * 100;
  const wrongDen = (w / (w + l + z)) * 100;
  const wrongLoss = (w / (w + l + z)) * 100;
  const ifZeroAsLoss = (w / (w + (l + z))) * 100;
  console.log({ closed: closed.length, wins: w, losses: l, pushes: z });
  console.log("Win rate (production: pushes excluded):", correct.toFixed(2) + "%");
  console.log("If pushes counted in denominator (w+l+z):", wrongDen.toFixed(2) + "%");
  console.log("If pushes counted as losses:", ifZeroAsLoss.toFixed(2) + "%");
}

main();
