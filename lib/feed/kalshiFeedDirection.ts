import type { WhaleTrade } from "@/lib/whaleTrades";

const RAW_BINARY_SELECTION_RE = /^(?:yes|no|true|false)$/i;

/**
 * Named contract/selection from Kalshi market metadata (yes/no sub-title, etc.).
 * Returns null when only a raw YES/NO token is available.
 */
export function resolveKalshiNamedSelection(
  trade: Pick<WhaleTrade, "source" | "selectionLabel">
): string | null {
  if (trade.source !== "kalshi") return null;

  const label = trade.selectionLabel?.trim();
  if (!label || RAW_BINARY_SELECTION_RE.test(label)) return null;

  return label;
}

/** True when a Kalshi row can show user-facing direction without raw YES/NO. */
export function hasSafeKalshiNamedSelection(
  trade: Pick<WhaleTrade, "source" | "selectionLabel">
): boolean {
  return resolveKalshiNamedSelection(trade) != null;
}

/**
 * User-facing direction label for Kalshi feed cards.
 * Uses trade.side (taker book side) — never infers buy/sell from YES/NO outcome.
 */
export function resolveKalshiFeedDirectionLabel(
  trade: Pick<WhaleTrade, "source" | "selectionLabel" | "side">
): string | null {
  const selection = resolveKalshiNamedSelection(trade);
  if (!selection) return null;

  if (trade.side === "SELL") {
    return `Exiting ${selection}`;
  }

  if (trade.side === "BUY") {
    return `Backing ${selection}`;
  }

  return null;
}
