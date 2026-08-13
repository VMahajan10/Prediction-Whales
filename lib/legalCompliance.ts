export const FINANCIAL_DISCLAIMER_STORAGE_KEY =
  "predictionwhales:financial-disclaimer-accepted-v1";

export const DATA_DELETION_EMAIL = "privacy@predictionwhales.com";

export const FEED_DISCLAIMER_TEXT =
  "Market odds, trade feeds, and EV metrics are derived from third-party platforms (Polymarket & Kalshi) for educational research only.";

export const AI_INSIGHT_DISCLAIMER_TEXT =
  "AI-generated insights and automated analysis are estimates only — not financial or investment advice.";

export const NON_AFFILIATION_DISCLAIMER_TEXT =
  "Prediction Whales is an independent third-party analytics tool. It aggregates and processes publicly available market data from trading platforms including Polymarket and Kalshi. Prediction Whales is not affiliated with, endorsed by, sponsored by, or associated with Polymarket, Kalshi, or their respective parent entities.";

export const DATA_SOURCE_INGESTION_DISCLOSURE_TEXT =
  "Our service collects publicly accessible market transactions, order book metrics, and wallet/account trade identifiers from public prediction market APIs and smart contracts (including Polymarket and Kalshi) to calculate performance analytics and EV metrics.";

export const PERFORMANCE_DISCLAIMER_TEXT =
  "EV metrics and historical trader records are provided for educational research. Past performance does not guarantee future results.";

export const FINANCIAL_DISCLAIMER_SUMMARY =
  "Prediction Whales provides market data and automated analysis for informational purposes only. Nothing in this app constitutes financial or investment advice. Trade at your own risk.";

/** Routes reachable without accepting the financial disclaimer modal. */
export function isLegalPublicPath(pathname: string): boolean {
  return (
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname.startsWith("/review/")
  );
}

export function hasAcceptedFinancialDisclaimer(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(FINANCIAL_DISCLAIMER_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

export function acceptFinancialDisclaimer(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FINANCIAL_DISCLAIMER_STORAGE_KEY, "true");
  } catch {
    // Non-fatal — modal may reappear on next visit.
  }
}

const LOCAL_STORAGE_KEYS = [
  FINANCIAL_DISCLAIMER_STORAGE_KEY,
  "marketpulse:whaleCache:v1",
  "marketpulse:bookmarkedTraders:v1",
  "marketpulse_portfolio",
  "marketpulse:traderAlerts:v1",
  "marketpulse_explorer_mode",
  "marketpulse_tour_active",
  "marketpulse.reviewDeciderName",
  "marketpulse_whale_sound",
  "marketpulse_copy_taps",
] as const;

const SESSION_STORAGE_PREFIXES = ["marketpulse:", "predictionwhales:"] as const;

/** Clears on-device preferences cached by the app (best-effort). */
export function clearAllLocalUserData(): void {
  if (typeof window === "undefined") return;

  for (const key of LOCAL_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage errors (private mode, etc.).
    }
  }

  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = window.sessionStorage.key(i);
      if (!key) continue;
      if (SESSION_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore session storage errors.
  }
}

export function buildDataDeletionMailto(): string {
  const subject = encodeURIComponent("Data Deletion Request");
  const body = encodeURIComponent(
    [
      "Hello Prediction Whales team,",
      "",
      "I would like to request deletion of my account and associated data.",
      "",
      "Email (if applicable):",
      "Device / platform:",
      "Additional details:",
      "",
      "Thank you.",
    ].join("\n")
  );
  return `mailto:${DATA_DELETION_EMAIL}?subject=${subject}&body=${body}`;
}
