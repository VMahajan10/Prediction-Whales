import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_WALLET_ADDRESS,
  ANONYMOUS_WHALE_PSEUDONYM,
  formatWalletPseudonym,
  resolveDeterministicWhalePseudonym,
} from "@/lib/x-agent/whaleRegistryDb";
import {
  formatWhaleDisplayLabel,
  isUnlabelledWhalePseudonym,
} from "@/lib/x-agent/whaleDisplay";

describe("whaleDisplay", () => {
  it("uses natural phrasing for anonymous wallets", () => {
    const label = formatWhaleDisplayLabel(
      ANONYMOUS_WALLET_ADDRESS,
      ANONYMOUS_WHALE_PSEUDONYM,
      () => 0
    );
    expect(label).toBe("A high-stakes wallet");
    expect(label).not.toContain("Anonymous Whale");
  });

  it("uses deterministic aliases for default wallet pseudonyms", () => {
    const wallet = "0xabcdef1234567890abcdef1234567890abcdef12";
    expect(
      isUnlabelledWhalePseudonym(wallet, formatWalletPseudonym(wallet))
    ).toBe(true);
    expect(
      formatWhaleDisplayLabel(wallet, formatWalletPseudonym(wallet))
    ).toBe(resolveDeterministicWhalePseudonym(wallet));
  });

  it("keeps named registry pseudonyms", () => {
    const wallet = "0xabcdef1234567890abcdef1234567890abcdef12";
    expect(formatWhaleDisplayLabel(wallet, "Zhang-match whale")).toBe(
      "Zhang-match whale"
    );
  });

  it("never maps placeholder wallets to Amber Specter #581", () => {
    expect(formatWhaleDisplayLabel("unknown", null, () => 0)).toBe(
      "A high-stakes wallet"
    );
  });
});
