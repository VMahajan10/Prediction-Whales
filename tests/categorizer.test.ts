import { describe, expect, it } from "vitest";
import { categorizeMarketByRegex } from "@/lib/categorizerRegex";

describe("categorizer", () => {
  it("classifies player-vs-player tennis titles as SPORTS", () => {
    expect(categorizeMarketByRegex("MCNALLY VS EALA")).toBe("SPORTS");
    expect(categorizeMarketByRegex("Sabalenka vs Gauff")).toBe("SPORTS");
  });

  it("classifies league acronyms as SPORTS", () => {
    expect(categorizeMarketByRegex("WTA Miami Open winner")).toBe("SPORTS");
    expect(categorizeMarketByRegex("NFL Super Bowl spread")).toBe("SPORTS");
  });

  it("classifies politics and culture keywords", () => {
    expect(categorizeMarketByRegex("2026 Senate control")).toBe("POLITICS");
    expect(categorizeMarketByRegex("Oscar best picture")).toBe("CULTURE");
  });

  it("returns null when uncertain", () => {
    expect(categorizeMarketByRegex("Random market question")).toBeNull();
  });
});
