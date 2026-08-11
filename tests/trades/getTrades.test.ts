import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/x-agent/getWhaleAlias", () => ({
  getWhaleAlias: vi.fn(),
}));

import { getWhaleAlias } from "@/lib/x-agent/getWhaleAlias";
import {
  enrichTradesWithWhaleAlias,
  resolveTradeWhaleAlias,
} from "@/lib/trades/getTrades";
import {
  KALSHI_TRADER_ALIAS,
  UNATTRIBUTED_TRADER_ALIAS,
} from "@/lib/trades/whaleAliasConstants";

const WALLET_A = "0xabcdef1234567890abcdef1234567890abcdef12";

describe("getTrades whale alias enrichment", () => {
  beforeEach(() => {
    vi.mocked(getWhaleAlias).mockReset();
  });

  it("resolves and persists deterministic aliases for polymarket wallets", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue("Cobalt Lynx #104");

    await expect(resolveTradeWhaleAlias(WALLET_A, "polymarket")).resolves.toBe(
      "Cobalt Lynx #104"
    );
    expect(getWhaleAlias).toHaveBeenCalledWith(WALLET_A);
  });

  it("never returns Anonymous Observer from the API layer", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue(null);

    const alias = await resolveTradeWhaleAlias(WALLET_A, "polymarket");
    expect(alias).not.toBe("Anonymous Observer");
    expect(alias).toMatch(/^[A-Za-z]+ [A-Za-z]+ #\d{3}$/);
  });

  it("uses Kalshi Trader for kalshi rows", async () => {
    await expect(resolveTradeWhaleAlias(null, "kalshi")).resolves.toBe(
      KALSHI_TRADER_ALIAS
    );
  });

  it("uses Unattributed Trader when no wallet is present", async () => {
    await expect(resolveTradeWhaleAlias(null, "polymarket")).resolves.toBe(
      UNATTRIBUTED_TRADER_ALIAS
    );
  });

  it("enriches batch trades with whaleAlias", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue("Amber Specter #581");

    const enriched = await enrichTradesWithWhaleAlias([
      {
        id: "t1",
        source: "polymarket",
        proxyWallet: WALLET_A,
      },
      {
        id: "k1",
        source: "kalshi",
      },
    ]);

    expect(enriched[0]!.whaleAlias).toBe("Amber Specter #581");
    expect(enriched[1]!.whaleAlias).toBe(KALSHI_TRADER_ALIAS);
  });

  it("drops null proxyWallet from enriched trades", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue("Amber Specter #581");

    const enriched = await enrichTradesWithWhaleAlias([
      {
        id: "k-null",
        source: "kalshi",
        proxyWallet: null,
      },
    ]);

    expect(enriched[0]!.whaleAlias).toBe(KALSHI_TRADER_ALIAS);
    expect(enriched[0]!.proxyWallet).toBeUndefined();
  });
});
