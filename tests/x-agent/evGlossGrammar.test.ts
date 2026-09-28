import { describe, expect, it } from "vitest";
import {
  EV_GLOSSES,
  evGlossForThey,
  progressiveEvGloss,
  type EvGloss,
} from "@/constants/evGlosses";

const BROKEN_THEY = /\b(they|as they|historically they)\s+profitable\b/i;

describe("evGlossForThey", () => {
  for (const gloss of EV_GLOSSES) {
    it(`they-form for "${gloss}" is grammatical`, () => {
      const they = evGlossForThey(gloss);
      expect(they.length).toBeGreaterThan(0);
      expect(BROKEN_THEY.test(`as ${they}`)).toBe(false);
      expect(BROKEN_THEY.test(`historically ${they}`)).toBe(false);

      const sample = `they ${they}`;
      expect(BROKEN_THEY.test(sample)).toBe(false);
      expect(sample).not.toMatch(/\bthey\s+profitable\b/);
    });
  }

  it("covers every gloss with distinct they-forms", () => {
    const forms = EV_GLOSSES.map((g) => evGlossForThey(g));
    expect(new Set(forms).size).toBe(EV_GLOSSES.length);
  });
});

describe("progressiveEvGloss", () => {
  for (const gloss of EV_GLOSSES) {
    it(`progressive form for "${gloss}" works after "still"`, () => {
      const progressive = progressiveEvGloss(gloss);
      expect(progressive.length).toBeGreaterThan(0);
      const sentence = `Still running +12% EV over 1,240 bets and still ${progressive}.`;
      expect(sentence.toLowerCase()).not.toMatch(/\bstill paid for\b/);
      expect(sentence).not.toMatch(/\bstill makes\b/);
      if (gloss === "profitable on average") {
        expect(sentence).toContain("still profitable on average");
      }
      if (gloss === "gets in at better prices than the market") {
        expect(sentence).toContain("still getting in at better prices than the market");
      }
    });
  }
});

describe("evGloss grammar matrix", () => {
  const contexts: Array<{ label: string; wrap: (they: string) => string }> = [
    { label: "they", wrap: (t) => `they ${t}` },
    { label: "as they", wrap: (t) => `as they ${t}` },
    { label: "historically they", wrap: (t) => `historically they ${t}` },
    { label: "still", wrap: (t) => `still ${progressiveEvGloss(t as EvGloss)}` },
  ];

  for (const gloss of EV_GLOSSES) {
    for (const ctx of contexts) {
      it(`${ctx.label} + ${gloss}`, () => {
        const text =
          ctx.label === "still"
            ? ctx.wrap(gloss)
            : ctx.wrap(evGlossForThey(gloss));
        expect(text).not.toMatch(/\bthey\s+profitable\b/i);
        expect(text).not.toMatch(/\bas they\s+profitable\b/i);
        expect(text).not.toMatch(/\bhistorically they\s+profitable\b/i);
      });
    }
  }
});
