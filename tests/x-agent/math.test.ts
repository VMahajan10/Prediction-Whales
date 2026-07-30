import { describe, expect, it } from "vitest";
import { calculateAvgEv, formatEvGloss } from "@/lib/x-agent/math";
import { EV_GLOSSES } from "@/constants/evGlosses";

describe("calculateAvgEv", () => {
  it("returns 0 for an empty resolved-bet history", () => {
    expect(calculateAvgEv([])).toBe(0);
  });

  it("averages EV across a mixed whale trade history", () => {
    const history = [
      { payout: 1.0, entryPrice: 0.4 },
      { payout: 0.0, entryPrice: 0.6 },
      { payout: 0.75, entryPrice: 0.5 },
    ];

    const expected =
      ((1.0 - 0.4) / 0.4 + (0.0 - 0.6) / 0.6 + (0.75 - 0.5) / 0.5) / 3;

    expect(calculateAvgEv(history)).toBeCloseTo(expected, 10);
    expect(calculateAvgEv(history)).toBeCloseTo(1 / 3, 10);
  });

  it("returns 0 when wins and losses offset", () => {
    expect(
      calculateAvgEv([
        { payout: 1.2, entryPrice: 1 },
        { payout: 0.8, entryPrice: 1 },
      ])
    ).toBe(0);
  });

  it("computes positive EV for a single winning bet", () => {
    expect(calculateAvgEv([{ payout: 1.5, entryPrice: 1 }])).toBe(0.5);
  });

  it("skips invalid entries instead of polluting the average", () => {
    const history = [
      { payout: 1.2, entryPrice: 0 },
      { payout: Number.NaN, entryPrice: 0.5 },
      { payout: 1.1, entryPrice: 0.55 },
    ];

    expect(calculateAvgEv(history)).toBeCloseTo((1.1 - 0.55) / 0.55, 10);
  });
});

describe("formatEvGloss", () => {
  it("returns a known plain-English gloss for each rng bucket", () => {
    for (let i = 0; i < EV_GLOSSES.length; i += 1) {
      const fraction = i / EV_GLOSSES.length;
      expect(formatEvGloss(0.12, () => fraction)).toBe(EV_GLOSSES[i]);
    }
  });

  it("excludes the prior gloss when requested", () => {
    const gloss = formatEvGloss(0.12, () => 0, {
      excludeGloss: EV_GLOSSES[0],
    });
    expect(gloss).not.toBe(EV_GLOSSES[0]);
    expect(EV_GLOSSES).toContain(gloss);
  });

  it("always returns one of the approved gloss strings", () => {
    for (let i = 0; i < 20; i += 1) {
      const gloss = formatEvGloss(0.08, () => i / 20);
      expect(EV_GLOSSES).toContain(gloss);
      expect(gloss.length).toBeGreaterThan(10);
      expect(gloss).not.toMatch(/https?:\/\//);
      expect(gloss).not.toContain("%");
    }
  });
});
