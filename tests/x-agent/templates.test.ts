import { describe, expect, it } from "vitest";
import {
  generateXPostCopy,
  TEMPLATE_FAMILIES,
  type TemplateSchemaInputs,
} from "@/lib/x-agent/templates";

const URL_PATTERN = /https?:\/\//;

function baseInputs(
  overrides: Partial<TemplateSchemaInputs> = {}
): TemplateSchemaInputs {
  return {
    whale: "DeepWallet",
    side: "Zhizhen Zhang",
    entry: 35,
    now: 42,
    avg_ev: 0.08,
    marketPlain: "China invade Taiwan",
    stakeNotional: 30_000,
    avgStakeNotional: 20_000,
    postedCount30d: 3,
    resolvedBetsCount: 512,
    winRate: 0.61,
    ...overrides,
  };
}

const SCENARIOS: Array<{
  name: string;
  inputs: TemplateSchemaInputs;
  lastFamilyUsed?: string;
}> = [
  {
    name: "repeat character",
    inputs: baseInputs({ postedCount30d: 3, entry: 52, now: 58 }),
  },
  {
    name: "quiet signal",
    inputs: baseInputs({ postedCount30d: 0, entry: 52, now: 52 }),
  },
  {
    name: "line moved",
    inputs: baseInputs({ postedCount30d: 0, entry: 52, now: 58 }),
    lastFamilyUsed: "V6",
  },
  {
    name: "contrarian",
    inputs: baseInputs({ postedCount30d: 0, entry: 35, now: 42 }),
  },
  {
    name: "conviction",
    inputs: baseInputs({
      postedCount30d: 0,
      entry: 52,
      now: undefined,
      stakeNotional: 52_000,
      avgStakeNotional: 20_000,
    }),
    lastFamilyUsed: "V7",
  },
  {
    name: "track record",
    inputs: baseInputs({ postedCount30d: 0, entry: 52, now: 52 }),
    lastFamilyUsed: "V4",
  },
  {
    name: "raw move",
    inputs: baseInputs({ postedCount30d: 0, entry: 52, now: 52 }),
    lastFamilyUsed: "V2",
  },
];

describe("generateXPostCopy safety rules", () => {
  it.each(SCENARIOS)("contains no URLs for $name", ({ inputs, lastFamilyUsed }) => {
    const { copyText } = generateXPostCopy(inputs, lastFamilyUsed, () => 0);

    expect(copyText).not.toMatch(URL_PATTERN);
  });

  it.each(SCENARIOS)("contains no siren emojis for $name", ({ inputs, lastFamilyUsed }) => {
    const { copyText } = generateXPostCopy(inputs, lastFamilyUsed, () => 0);

    expect(copyText).not.toContain("🚨");
  });
});

describe("generateXPostCopy family rotation", () => {
  it("does not pick the same template family back-to-back across sequential generations", () => {
    const rotatingInputs = baseInputs({
      entry: 35,
      now: 42,
      postedCount30d: 3,
      avgStakeNotional: 20_000,
    });

    let lastFamily: string | undefined;

    for (let i = 0; i < 12; i += 1) {
      const { family } = generateXPostCopy(rotatingInputs, lastFamily, () => 0);

      expect(TEMPLATE_FAMILIES).toContain(family);

      if (lastFamily) {
        expect(family).not.toBe(lastFamily);
      }

      lastFamily = family;
    }
  });
});
