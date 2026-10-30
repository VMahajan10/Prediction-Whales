/**
 * Category labels for PF buckets from Gamma event tags (not market titles).
 */

const SLUG_TO_BADGE: Record<string, string> = {
  nba: "NBA",
  mlb: "MLB",
  nhl: "NHL",
  wta: "WTA",
  atp: "ATP",
  soccer: "SOCCER",
  esports: "ESPORTS",
  "pop-culture": "CULTURE",
  culture: "CULTURE",
  politics: "POLITICS",
  crypto: "CRYPTO",
  tech: "MARKET",
  economics: "ECONOMICS",
  economy: "ECONOMICS",
};

const COARSE_PRIORITY = [
  "Politics",
  "Crypto",
  "Sports",
  "Esports",
  "Economy",
  "Entertainment",
];

/** Slugs that indicate a real game / team / player market (not halftime, celeb, macro). */
const SPORTS_OR_GAMES_SLUGS = new Set([
  "sports",
  "games",
  "game",
  "ncaa",
  "ncaa-basketball",
  "ncaa-football",
  "soccer",
  "basketball",
  "football",
  "baseball",
  "hockey",
  "tennis",
  "golf",
  "mma",
  "ufc",
  "boxing",
  "cricket",
  "f1",
  "formula-1",
]);

const CULTURE_SLUGS = new Set([
  "pop-culture",
  "culture",
  "celebrities",
  "entertainment",
  "music",
  "awards",
  "movies",
  "tv",
]);

const ECONOMICS_SLUGS = new Set([
  "economics",
  "economy",
  "fed",
  "finance",
  "macro",
  "inflation",
  "gdp",
  "jobs",
]);

const CULTURE_LABEL_HINTS = [
  "halftime",
  "super bowl",
  "celebrity",
  "wedding",
  "grammy",
  "oscar",
  "taylor swift",
  "bad bunny",
];

const ECONOMICS_LABEL_HINTS = [
  "inflation",
  "gdp",
  "fed ",
  "interest rate",
  "unemployment",
  "cpi",
  "jobs report",
];

function tagLabelStrings(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object") {
        const o = t as { label?: string; slug?: string };
        return o.label?.trim() || o.slug?.trim() || "";
      }
      return "";
    })
    .filter(Boolean);
}

function tagSlugs(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (t && typeof t === "object" && "slug" in t) {
        return String((t as { slug?: string }).slug ?? "").toLowerCase();
      }
      return "";
    })
    .filter(Boolean);
}

function toCoarseBucket(labels: string[]): string {
  if (!labels.length) return "Other";
  for (const cat of COARSE_PRIORITY) {
    if (labels.some((t) => t.toLowerCase() === cat.toLowerCase())) return cat;
  }
  return labels[0] ?? "Other";
}

function labelsLower(labels: string[]): string[] {
  return labels.map((l) => l.toLowerCase());
}

function hasSportsOrGamesContext(slugSet: Set<string>, labels: string[]): boolean {
  for (const s of SPORTS_OR_GAMES_SLUGS) {
    if (slugSet.has(s)) return true;
  }
  const low = labelsLower(labels);
  for (const l of low) {
    if (l === "sports" || l === "games" || l.includes("game")) return true;
  }
  return false;
}

function hasNflTag(slugSet: Set<string>, labels: string[]): boolean {
  if (slugSet.has("nfl")) return true;
  return labelsLower(labels).some((l) => l === "nfl" || l.includes("nfl"));
}

function cultureFromTags(slugSet: Set<string>, labels: string[]): boolean {
  for (const s of CULTURE_SLUGS) {
    if (slugSet.has(s)) return true;
  }
  const joined = labelsLower(labels).join(" ");
  return CULTURE_LABEL_HINTS.some((h) => joined.includes(h));
}

function economicsFromTags(slugSet: Set<string>, labels: string[]): boolean {
  for (const s of ECONOMICS_SLUGS) {
    if (slugSet.has(s)) return true;
  }
  const joined = labelsLower(labels).join(" ");
  return ECONOMICS_LABEL_HINTS.some((h) => joined.includes(h));
}

/** Primary PF category label from Gamma event `tags` array. */
export function categoryLabelFromEventTags(tags: unknown): string | null {
  const slugs = tagSlugs(tags);
  const slugSet = new Set(slugs);
  const labels = tagLabelStrings(tags);

  if (cultureFromTags(slugSet, labels)) return "CULTURE";
  if (economicsFromTags(slugSet, labels)) return "ECONOMICS";

  if (hasNflTag(slugSet, labels) && hasSportsOrGamesContext(slugSet, labels)) {
    return "NFL";
  }

  for (const slug of slugs) {
    if (slug === "nfl") continue;
    const mapped = SLUG_TO_BADGE[slug];
    if (mapped) return mapped;
    const short = slug.replace(/-/g, "");
    for (const [key, badge] of Object.entries(SLUG_TO_BADGE)) {
      if (key === "nfl") continue;
      if (slug.includes(key) || short.includes(key.replace(/-/g, ""))) {
        return badge;
      }
    }
  }

  if (!labels.length) return null;

  for (const label of labels) {
    const norm = label.toLowerCase();
    const fromSlug = SLUG_TO_BADGE[norm.replace(/\s+/g, "-")];
    if (fromSlug && fromSlug !== "NFL") return fromSlug;
  }

  const coarse = toCoarseBucket(labels);
  if (coarse === "Sports") return "SPORTS";
  if (coarse === "Politics") return "POLITICS";
  if (coarse === "Entertainment") return "CULTURE";
  if (coarse === "Economy") return "ECONOMICS";
  return coarse.toUpperCase() === coarse ? coarse : coarse;
}
