import { describe, expect, it } from "vitest";
import {
  calculateCLV,
  resolveClvScore,
  resolveWalletClvScore,
} from "@/lib/metrics/clv";

describe("calculateCLV", () => {
  it("computes relative closing-line edge", () => {
    expect(calculateCLV({ entryPrice: 0.4, closingPrice: 0.5 })).toBeCloseTo(
      0.25
    );
    expect(calculateCLV({ entryPrice: 0.5, closingPrice: 0.45 })).toBeCloseTo(
      -0.1
    );
  });

  it("returns null for invalid prices", () => {
    expect(calculateCLV({ entryPrice: 0, closingPrice: 0.5 })).toBeNull();
    expect(
      calculateCLV({ entryPrice: 0.4, closingPrice: Number.NaN })
    ).toBeNull();
  });
});

describe("resolveWalletClvScore", () => {
  it("prefers roi over avgEv", () => {
    expect(resolveWalletClvScore({ roi: 0.08, avgEv: 0.03 })).toBe(0.08);
  });

  it("falls back to avgEv when roi is missing", () => {
    expect(resolveWalletClvScore({ avgEv: 0.035 })).toBe(0.035);
  });

  it("normalizes percentage-style roi", () => {
    expect(resolveWalletClvScore({ roi: 8 })).toBeCloseTo(0.08);
  });
});

describe("resolveClvScore", () => {
  it("uses closing-line CLV when available", () => {
    expect(
      resolveClvScore({
        entryPrice: 0.4,
        closingPrice: 0.5,
        wallet: { roi: 0.2, avgEv: 0.1 },
      })
    ).toBeCloseTo(0.25);
  });

  it("falls back to wallet roi then avgEv", () => {
    expect(
      resolveClvScore({
        entryPrice: 0.4,
        closingPrice: null,
        wallet: { roi: 0.06, avgEv: 0.02 },
      })
    ).toBe(0.06);

    expect(
      resolveClvScore({
        entryPrice: 0.4,
        closingPrice: undefined,
        wallet: { avgEv: 0.02 },
      })
    ).toBe(0.02);
  });
});
