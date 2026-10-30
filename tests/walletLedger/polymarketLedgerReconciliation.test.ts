import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { ledgerNetWithinProfileTolerance } from "@/lib/walletLedger/reconciliation/profilePnl";
import { fetchPolymarketProfilePnl } from "@/lib/walletLedger/reconciliation/fetchProfilePnl";

const RECONCILIATION_WALLETS = [
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
  "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882",
  "0xad529df14c293d77984a0137990a1441b25211ac",
];

const RUN_INTEGRATION = process.env.WALLET_LEDGER_RECONCILIATION_TEST === "1";

describe("polymarket ledger profile reconciliation", () => {
  it("tolerance helper accepts within 5%", () => {
    expect(ledgerNetWithinProfileTolerance(-100, -105)).toBe(true);
    expect(ledgerNetWithinProfileTolerance(-100, -200)).toBe(false);
  });

  (RUN_INTEGRATION ? it : it.skip)(
    "ledger net PnL within 5% of profile Total PnL (3 wallets)",
    async () => {
      if (!isDatabaseEnabled()) {
        throw new Error("DATABASE_URL required");
      }
      const db = getDb();
      for (const wallet of RECONCILIATION_WALLETS) {
        const rows = await db.execute(sql`
          select
            coalesce(sum(case when completed and realized_pnl > 0 then realized_pnl else 0 end), 0)::float as gp,
            coalesce(sum(case when completed and realized_pnl < 0 then abs(realized_pnl) else 0 end), 0)::float as gl
          from wallet_position_lifecycles
          where lower(wallet_address)=${wallet}
            and completed = true
            and realized_pnl is not null
        `);
        const gp = Number((rows.rows[0] as { gp: number }).gp);
        const gl = Number((rows.rows[0] as { gl: number }).gl);
        const ledgerNet = gp - gl;
        const profile = await fetchPolymarketProfilePnl(wallet);
        expect(profile.pnl).not.toBeNull();
        expect(
          ledgerNetWithinProfileTolerance(ledgerNet, profile.pnl as number),
          `${wallet} ledger=${ledgerNet} profile=${profile.pnl}`
        ).toBe(true);
      }
    }
  );
});
