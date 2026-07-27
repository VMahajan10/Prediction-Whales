export function formatReviewEvLabel(evPercent: number | null): string {
  if (evPercent == null || !Number.isFinite(evPercent)) return "N/A";
  const sign = evPercent >= 0 ? "+" : "";
  return `${sign}${evPercent.toFixed(1)}%`;
}

export function formatReviewStakeUsd(stakeNotional: number): string {
  return `$${Math.round(stakeNotional).toLocaleString("en-US")}`;
}

export function humanizeMarketSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
