import { describe, expect, it } from "vitest";
import {
  MIN_TEMPLATE_RESOLVED_BETS,
  TEMPLATES_MD_GATE_RESOLVED_BETS_FLOOR,
} from "@/lib/templates/templatesDoc";
import { CREDIBILITY_CONFIG } from "@/lib/feedQualification";

describe("Templates.md resolved bet floors", () => {
  it("documents §6 gate floor as 500 (gates before copy)", () => {
    expect(TEMPLATES_MD_GATE_RESOLVED_BETS_FLOOR).toBe(500);
  });

  it("template engine uses upstream credibility floor, not §6 gate value", () => {
    expect(MIN_TEMPLATE_RESOLVED_BETS).toBe(CREDIBILITY_CONFIG.MIN_RESOLVED_BETS);
    expect(MIN_TEMPLATE_RESOLVED_BETS).not.toBe(
      TEMPLATES_MD_GATE_RESOLVED_BETS_FLOOR
    );
  });
});
