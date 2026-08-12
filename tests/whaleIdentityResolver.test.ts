import { describe, expect, it } from "vitest";
import {
  generateDeterministicWhalePseudonym,
  generateUniqueTraderName,
  getUniqueTraderName,
  hashWalletAddress,
  isHexWalletDisplay,
  isUsableCustomWhaleName,
  resolveFeedTraderDisplayName,
  resolveWhaleIdentity,
  sanitizeWhaleDisplayName,
  UNIQUE_TRADER_NAME_PATTERN,
  WHALE_TRADER_FALLBACK_ALIAS,
} from "@/lib/whaleIdentityResolver";

const WALLET = "0xabcdef1234567890abcdef1234567890abcdef12";

describe("whaleIdentityResolver", () => {
  it("generates deterministic compact trader names from wallet hash", () => {
    const first = generateUniqueTraderName(WALLET);
    const second = generateUniqueTraderName(WALLET);

    expect(first).toMatch(UNIQUE_TRADER_NAME_PATTERN);
    expect(second).toBe(first);
    expect(generateDeterministicWhalePseudonym(WALLET)).toBe(first);
    expect(hashWalletAddress(WALLET)).toBe(hashWalletAddress(WALLET));
  });

  it("uses registry custom names when they are not hex fragments", () => {
    const identity = resolveWhaleIdentity(WALLET, "Zhang-match whale", {
      winRate: 0.62,
      resolvedBetsCount: 412,
      avgEv: 0.035,
    });

    expect(identity.pseudonym).toBe("Zhang-match whale");
    expect(identity.initials).toBe("ZW");
    expect(identity.winRate).toBe(0.62);
    expect(identity.resolvedBetsCount).toBe(412);
    expect(identity.avgEv).toBe(0.035);
    expect(identity.roi).toBe(0.035);
    expect(identity.clvScore).toBe(0.035);
  });

  it("rejects hex-like custom names and falls back to compact aliases", () => {
    expect(isHexWalletDisplay("0xabc1…e2Db")).toBe(true);
    expect(isUsableCustomWhaleName("0xabc1…e2Db", WALLET)).toBe(false);

    const identity = resolveWhaleIdentity(WALLET, "0xabc1…e2Db", {
      winRate: 0.5,
      resolvedBetsCount: 300,
      avgEv: 0.03,
    });

    expect(identity.pseudonym).not.toContain("0x");
    expect(identity.pseudonym).toMatch(UNIQUE_TRADER_NAME_PATTERN);
  });

  it("never sanitizes to a raw wallet fragment", () => {
    const sanitized = sanitizeWhaleDisplayName("0xabcd…ef12", WALLET);
    expect(sanitized).not.toContain("0x");
    expect(sanitized).toMatch(UNIQUE_TRADER_NAME_PATTERN);
  });

  it("prioritizes registry aliases for feed display", () => {
    expect(
      resolveFeedTraderDisplayName({
        wallet: WALLET,
        whaleAlias: "Zhang-match whale",
        pseudonym: "Other Name",
      })
    ).toBe("Zhang-match whale");
  });

  it("generates a compact alias when no custom name is available", () => {
    expect(
      getUniqueTraderName({
        proxyWallet: WALLET,
      })
    ).toBe(generateUniqueTraderName(WALLET));
  });

  it("keeps legacy tier aliases when provided on the trade", () => {
    expect(
      getUniqueTraderName({
        proxyWallet: WALLET,
        whaleAlias: "Silver Champion #640",
      })
    ).toBe("Silver Champion #640");
  });

  it("uses Whale Trader when the wallet is missing", () => {
    expect(getUniqueTraderName({})).toBe(WHALE_TRADER_FALLBACK_ALIAS);
  });
});
