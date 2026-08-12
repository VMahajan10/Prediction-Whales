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
import { KALSHI_TRADER_ALIAS } from "@/lib/trades/whaleAliasConstants";
import {
  getUniqueTraderName,
  UNIQUE_TRADER_NAME_PATTERN,
} from "@/lib/whaleIdentityResolver";

const WALLET_A = "0xabcdef1234567890abcdef1234567890abcdef12";

describe("getTrades whale alias enrichment", () => {
  beforeEach(() => {
    vi.mocked(getWhaleAlias).mockReset();
  });

  it("resolves and persists deterministic aliases for polymarket wallets", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue("CobaltLynx104");

    await expect(resolveTradeWhaleAlias(WALLET_A, "polymarket")).resolves.toBe(
      "CobaltLynx104"
    );
    expect(getWhaleAlias).toHaveBeenCalledWith(WALLET_A);
  });

  it("never returns Anonymous Observer from the API layer", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue(null);

    const alias = await resolveTradeWhaleAlias(WALLET_A, "polymarket");
    expect(alias).not.toBe("Anonymous Observer");
    expect(alias).toMatch(UNIQUE_TRADER_NAME_PATTERN);
  });

  it("uses Kalshi Trader for kalshi rows", async () => {
    await expect(resolveTradeWhaleAlias(null, "kalshi")).resolves.toBe(
      KALSHI_TRADER_ALIAS
    );
  });

  it("hashes trade identity instead of Whale Trader when no wallet is present", async () => {
    const alias = await resolveTradeWhaleAlias(null, "polymarket", {
      id: "trade-missing-wallet",
      transactionHash: "0xdeadbeef",
    });
    expect(alias).not.toBe("Whale Trader");
    expect(alias).toMatch(UNIQUE_TRADER_NAME_PATTERN);
    expect(alias).toBe(
      getUniqueTraderName({
        id: "trade-missing-wallet",
        transactionHash: "0xdeadbeef",
      })
    );
  });

  it("enriches batch trades with whaleAlias and displayName", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue("AmberSpecter581");

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
      {
        id: "t-missing",
        source: "polymarket",
        transactionHash: "0xabc123",
      },
    ]);

    expect(enriched[0]!.whaleAlias).toBe("AmberSpecter581");
    expect(enriched[0]!.displayName).toBe("AmberSpecter581");
    expect(enriched[1]!.whaleAlias).toBe(KALSHI_TRADER_ALIAS);
    expect(enriched[2]!.displayName).toMatch(UNIQUE_TRADER_NAME_PATTERN);
    expect(enriched[2]!.displayName).not.toBe("Whale Trader");
  });

  it("extracts wallets from alternate payload keys during enrichment", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue("SolarPioneer222");

    const enriched = await enrichTradesWithWhaleAlias([
      {
        id: "alt-key",
        source: "polymarket",
        maker_address: WALLET_A,
      },
    ]);

    expect(enriched[0]!.proxyWallet).toBe(WALLET_A);
    expect(enriched[0]!.displayName).toBe("SolarPioneer222");
  });

  it("drops null proxyWallet from enriched trades", async () => {
    vi.mocked(getWhaleAlias).mockResolvedValue("AmberSpecter581");

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
