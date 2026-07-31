import { describe, expect, it } from "vitest";
import {
  formatExitByLabel,
  translateMarketPosition,
  translateWhaleTradeMarket,
} from "@/lib/marketTranslator";

describe("translateMarketPosition", () => {
  it("maps YES on candidate A to Backing Candidate A in a matchup", () => {
    const result = translateMarketPosition(
      {
        title: "Candidate A vs Candidate B",
        endDate: "2026-12-31T00:00:00.000Z",
      },
      { outcome: "Yes" }
    );

    expect(result).toEqual({
      backingLabel: "Backing Candidate A",
      sideName: "Candidate A",
      exitByLabel: "Exit by Dec 31, 2026",
    });
  });

  it("maps NO on candidate A to Backing Candidate B in a 2-outcome matchup", () => {
    const result = translateMarketPosition(
      { title: "Candidate A vs Candidate B" },
      { outcome: "No" }
    );

    expect(result).toEqual({
      backingLabel: "Backing Candidate B",
      sideName: "Candidate B",
      exitByLabel: undefined,
    });
  });

  it("returns null for raw NO on non-matchup markets", () => {
    expect(
      translateMarketPosition(
        { title: "Will Candidate A win the election?" },
        { outcome: "No" }
      )
    ).toBeNull();
  });

  it("maps YES on a will-question market to the named subject", () => {
    const result = translateMarketPosition(
      { title: "Will Candidate A win the election?" },
      { outcome: "Yes" }
    );

    expect(result?.backingLabel).toBe("Backing Candidate A win the election");
  });

  it("uses declared outcomes when provided", () => {
    const result = translateMarketPosition(
      {
        title: "Match winner",
        outcomes: ["Lakers", "Celtics"],
      },
      { outcome: "No" }
    );

    expect(result?.backingLabel).toBe("Backing Celtics");
  });

  it("formats exit dates as Exit by [Date]", () => {
    expect(formatExitByLabel("2026-07-31T12:00:00.000Z")).toBe(
      "Exit by Jul 31, 2026"
    );
  });
});

describe("translateWhaleTradeMarket", () => {
  it("translates whale trade payloads for feed filtering", () => {
    const result = translateWhaleTradeMarket({
      title: "Candidate A vs Candidate B",
      outcome: "Yes",
      side: "BUY",
      slug: "candidate-a-vs-b",
    });

    expect(result?.sideName).toBe("Candidate A");
  });
});
