import { describe, expect, it } from "vitest";
import {
  generateUniqueTraderName,
  hashWalletAddress,
  UNIQUE_TRADER_NAME_PATTERN,
} from "@/lib/whaleIdentityResolver";
import {
  needsGeneratedWhalePseudonym,
} from "@/lib/x-agent/getWhaleAlias";
import {
  formatWhaleDisplayLabel,
  isUnlabelledWhalePseudonym,
} from "@/lib/x-agent/whaleDisplay";
import {
  formatWalletPseudonym,
  resolveDeterministicWhalePseudonym,
} from "@/lib/x-agent/whaleRegistryDb";

const WALLET_A = "0xabcdef1234567890abcdef1234567890abcdef12";
const WALLET_B = "0x1111111111111111111111111111111111111111";

describe("deterministic whale aliases", () => {
  it("generates different aliases for different wallets", () => {
    const aliasA = generateUniqueTraderName(WALLET_A);
    const aliasB = generateUniqueTraderName(WALLET_B);

    expect(aliasA).not.toBe(aliasB);
    expect(aliasA).toMatch(UNIQUE_TRADER_NAME_PATTERN);
  });

  it("does not use the shared unknown-wallet alias", () => {
    expect(generateUniqueTraderName("unknown")).toMatch(
      UNIQUE_TRADER_NAME_PATTERN
    );
    expect(generateUniqueTraderName("unknown")).not.toBe("AnonymousTrader102");
    expect(generateUniqueTraderName(WALLET_A)).not.toBe(
      generateUniqueTraderName("unknown")
    );
  });

  it("uses deterministic aliases for hex registry pseudonyms", () => {
    const wallet = WALLET_A;
    expect(isUnlabelledWhalePseudonym(wallet, formatWalletPseudonym(wallet))).toBe(
      true
    );
    expect(
      formatWhaleDisplayLabel(wallet, formatWalletPseudonym(wallet))
    ).toBe(resolveDeterministicWhalePseudonym(wallet));
  });

  it("flags placeholder and hex pseudonyms for regeneration", () => {
    expect(needsGeneratedWhalePseudonym(WALLET_A, formatWalletPseudonym(WALLET_A))).toBe(
      true
    );
    expect(needsGeneratedWhalePseudonym(WALLET_A, "Zhang-match whale")).toBe(
      false
    );
  });

  it("is stable for the same wallet hash", () => {
    expect(hashWalletAddress(WALLET_A)).toBe(hashWalletAddress(WALLET_A));
    expect(generateUniqueTraderName(WALLET_A)).toBe(
      generateUniqueTraderName(WALLET_A)
    );
  });
});
