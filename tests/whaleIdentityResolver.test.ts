import { describe, expect, it } from "vitest";
import {
  generateDeterministicWhalePseudonym,
  hashWalletAddress,
  isHexWalletDisplay,
  isUsableCustomWhaleName,
  resolveWhaleIdentity,
  sanitizeWhaleDisplayName,
} from "@/lib/whaleIdentityResolver";

const WALLET = "0xabcdef1234567890abcdef1234567890abcdef12";

describe("whaleIdentityResolver", () => {
  it("generates deterministic pseudonyms from wallet hash", () => {
    const first = generateDeterministicWhalePseudonym(WALLET);
    const second = generateDeterministicWhalePseudonym(WALLET);

    expect(first).toMatch(/^[A-Za-z]+ [A-Za-z]+ #\d{3}$/);
    expect(second).toBe(first);
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
  });

  it("rejects hex-like custom names and falls back to deterministic pseudonyms", () => {
    expect(isHexWalletDisplay("0xabc1…e2Db")).toBe(true);
    expect(isUsableCustomWhaleName("0xabc1…e2Db", WALLET)).toBe(false);

    const identity = resolveWhaleIdentity(WALLET, "0xabc1…e2Db", {
      winRate: 0.5,
      resolvedBetsCount: 300,
      avgEv: 0.03,
    });

    expect(identity.pseudonym).not.toContain("0x");
    expect(identity.pseudonym).toMatch(/#\d{3}$/);
  });

  it("never sanitizes to a raw wallet fragment", () => {
    const sanitized = sanitizeWhaleDisplayName("0xabcd…ef12", WALLET);
    expect(sanitized).not.toContain("0x");
    expect(sanitized).toMatch(/#\d{3}$/);
  });
});
