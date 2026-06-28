import type { EvPlatform } from "@/lib/evPipeline/types";

const MONTHS =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi;

const POLYMARKET_QUESTION_PREFIX =
  /^(will|does|do|did|is|are|was|were|can|could|should|would|has|have|who|what|when|where|how)\s+(the\s+)?/i;

const KALSHI_TITLE_PREFIXES = [
  /^pro\s+basketball\s+/i,
  /^pro\s+football\s+/i,
  /^pro\s+baseball\s+/i,
  /^pro\s+hockey\s+/i,
  /^pro\s+basketball\s+finals\s+/i,
  /^nba\s+/i,
  /^nfl\s+/i,
  /^mlb\s+/i,
  /^nhl\s+/i,
  /^fed\s+/i,
  /^fomc\s+/i,
  /^cpi\s+/i,
  /^gdp\s+/i,
];

/** Strip boilerplate so PM questions align with Kalshi headline-style titles. */
export function normalizeTitleForEmbedding(
  title: string,
  platform?: EvPlatform
): string {
  let text = title.trim();
  if (!text) return "";

  if (platform === "kalshi") {
    for (const re of KALSHI_TITLE_PREFIXES) {
      text = text.replace(re, "");
    }
  }

  if (platform === "polymarket" || !platform) {
    text = text.replace(POLYMARKET_QUESTION_PREFIX, "");
  }

  text = text
    .replace(/\?+$/, "")
    .replace(/\s*-\s*polymarket\s*$/i, "")
    .replace(/\s*\|\s*kalshi\s*$/i, "")
    .replace(/\([^)]*\)$/g, (paren) =>
      /yes|no|contract|market|ticker|kx/i.test(paren) ? "" : paren
    )
    .replace(/\b(rate\s+cut|cuts?\s+rates?|interest\s+rate\s+cut)\b/gi, "rate cut")
    .replace(/\b(increase|hike|raise)\s+rates?\b/gi, "rate hike")
    .replace(/\bthe\s+federal\s+reserve\b/gi, "fed")
    .replace(/\bfederal\s+reserve\b/gi, "fed")
    .replace(/\bfomc\b/gi, "fed")
    .replace(/\bbitcoin\b/gi, "bitcoin btc")
    .replace(/\bethereum\b/gi, "ethereum eth")
    .replace(/\b15\s*[- ]?\s*min(?:ute)?s?\b/gi, "15 minute intraday")
    .replace(MONTHS, (m) => m.toLowerCase())
    .replace(/[^\w\s%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return text;
}

export function buildNormalizedEmbeddingText(
  title: string,
  description: string,
  platform: EvPlatform
): string {
  const normalizedTitle = normalizeTitleForEmbedding(title, platform);
  const normalizedDescription = description
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000)
    .toLowerCase();

  const combined = [normalizedTitle, normalizedDescription]
    .filter(Boolean)
    .join("\n");

  return combined.slice(0, 8000);
}
