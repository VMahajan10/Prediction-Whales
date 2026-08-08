import type { MarketFeedCategory } from "@/lib/constants/categories";

const ESPORTS_PROBE =
  /lol|lec|lcs|lck|lpl|cs2|csgo|valorant|dota|dota2|esports|esport|vct|msi|worlds|blast|iem|esl|major|map\s*\d/i;

const SPORTS_REGEXES: RegExp[] = [
  /\b(wta|atp|nba|nfl|nhl|mlb|mls|ufc|pga|f1|ncaa|epl|ucl|serie\s*a|bundesliga|ligue\s*1|nascar|mlb)\b/i,
  /\bvs\.?\b|\bv\s+s\b/i,
  /\bo\/u\b|\bover\/under\b|\bspread\b|\bmoneyline\b/i,
  /\b(tennis|soccer|football|basketball|baseball|hockey|golf|boxing|mma|cricket|rugby)\b/i,
  /\b(touchdown|goalscorer|world\s+cup|super\s+bowl|playoffs?)\b/i,
  /\b[A-Z]{2,}(?:\s+[A-Z]{2,})*\s+VS\.?\s+[A-Z]{2,}(?:\s+[A-Z]{2,})*\b/,
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+vs\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/,
  ESPORTS_PROBE,
];

const POLITICS_REGEXES: RegExp[] = [
  /\b(congress|senate|house|president|election|primary|democrat|republican|governor|parliament)\b/i,
  /\b(trump|biden|harris|modi|starmer|macron)\b/i,
  /\b(federal|fed\s+chair|fed\s+rate|white\s+house|supreme\s+court)\b/i,
];

const CULTURE_REGEXES: RegExp[] = [
  /\b(oscar|grammy|emmy|tony|billboard|album|movie|celebrity|tiktok|twitter|culture)\b/i,
  /\b(netflix|spotify|box\s+office|reality\s+tv)\b/i,
];

/**
 * High-confidence regex classification. Returns null when uncertain (LLM may run).
 */
export function categorizeMarketByRegex(
  title: string,
  eventSlug?: string
): MarketFeedCategory | null {
  const corpus = `${title} ${eventSlug ?? ""}`.trim();
  if (!corpus) return null;

  const t = corpus.toLowerCase();

  if (SPORTS_REGEXES.some((re) => re.test(corpus))) return "SPORTS";
  if (POLITICS_REGEXES.some((re) => re.test(t))) return "POLITICS";
  if (CULTURE_REGEXES.some((re) => re.test(t))) return "CULTURE";
  if (/btc|eth|crypto|bitcoin|solana|token|defi/.test(t)) return "OTHER";

  return null;
}
