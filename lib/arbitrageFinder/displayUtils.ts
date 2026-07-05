export function normalizeTradeOutcomeSide(
  outcome: string | null | undefined
): "YES" | "NO" | null {
  if (!outcome) return null;
  const normalized = outcome.trim().toLowerCase();
  if (normalized === "yes") return "YES";
  if (normalized === "no") return "NO";
  return null;
}
