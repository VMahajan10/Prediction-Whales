import type { CrossMarketEv } from "@/lib/crossMarketEv";

export function roundPrice(p: number | null | undefined): number | null {
  if (p == null || !Number.isFinite(p)) return null;
  return Math.round(p * 100) / 100;
}

export function roundEvPercent(ev: number | null | undefined): number | null {
  if (ev == null || !Number.isFinite(ev)) return null;
  return Math.round(ev * 10) / 10;
}

export function formatEvPercent(ev: number): string {
  const rounded = roundEvPercent(ev)!;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

export function fairSourceLabel(
  source: NonNullable<CrossMarketEv["fairSource"]>
): string {
  return source === "kalshi" ? "Kalshi" : "Polymarket";
}

export function evColorClass(ev: number): string {
  const rounded = roundEvPercent(ev)!;
  if (Math.abs(rounded) < 0.05) return "text-slate-400";
  return rounded > 0 ? "text-green-400" : "text-red-400";
}

export type EvPricingSignal = "UNDERPRICED" | "OVERPRICED" | "FAIRLY PRICED";

/** Price-vs-fair signal from EV% (positive = paid below fair reference). */
export function evPricingSignal(ev: number): EvPricingSignal {
  const rounded = roundEvPercent(ev)!;
  if (Math.abs(rounded) < 2) return "FAIRLY PRICED";
  return rounded > 0 ? "UNDERPRICED" : "OVERPRICED";
}

export function evPricingSignalClass(signal: EvPricingSignal): string {
  if (signal === "UNDERPRICED") return "text-green-400";
  if (signal === "OVERPRICED") return "text-red-400";
  return "text-slate-400";
}

export function crossMarketEvUnavailableReason(
  reason: NonNullable<CrossMarketEv["reason"]>
): string {
  switch (reason) {
    case "no_match":
      return "No matched Polymarket market for this Kalshi contract.";
    case "fair_line_stale":
      return "Matched market quote is stale — comparison suppressed.";
    case "in_play":
      return "Game is in play — cross-market comparison paused.";
    case "missing_price":
      return "Missing live prices on one or both markets.";
    default:
      return "Cross-market comparison unavailable.";
  }
}
