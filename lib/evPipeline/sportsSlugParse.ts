import type { ParsedGameKey } from "@/lib/crossMarketEv";
import { fuzzyCountryNameToPm } from "@/lib/sportsTeamMatch";
import { normalizePmTeamCode, pmCodeToKalshi, pmTeamCodesEquivalent } from "@/lib/teamCodes";

/** PM game slugs: `{league}-{teamA}-{teamB}-{YYYY-MM-DD}[-suffix]`. */
export const GENERIC_PM_GAME_SLUG =
  /^([a-z][a-z0-9]{1,12})-([a-z][a-z0-9]{1,12})-([a-z][a-z0-9]{1,12})-(\d{4}-\d{2}-\d{2})(?:-(.+))?$/i;

/** Legacy FIFA World Cup slug (alias of generic). */
export const FIFA_PM_GAME_SLUG = GENERIC_PM_GAME_SLUG;

export const ESPORTS_LEAGUE_PREFIXES =
  /^(lol|lec|lcs|lck|lpl|cs2|csgo|valorant|dota|dota2|vct|msi|worlds|blast|iem|esl|major)/i;

export const SPORTS_PROBE =
  /mlb|nfl|nba|nhl|mls|fifa|world cup|soccer|tennis|wta|atp|o\/u|over\/under|spread|vs\.|versus|\bv\.?\b|goals|map\s*\d|series winner|match winner|lol|lec|lcs|lck|lpl|cs2|valorant|dota|esports|esport/i;

export interface ParsedPmGameSlug {
  league: string;
  pmTeamA: string;
  pmTeamB: string;
  date: string;
  suffix: string | null;
  isEsports: boolean;
}

export function isEsportsLeague(league: string): boolean {
  return ESPORTS_LEAGUE_PREFIXES.test(league);
}

export function isEsportsProbe(text: string): boolean {
  return /lol|lec|lcs|lck|lpl|cs2|csgo|valorant|dota|esports|esport|vct|msi|worlds|blast|iem|esl|major|map\s*\d/i.test(
    text.toLowerCase()
  );
}

export function isSportsMarketProbe(
  slug?: string | null,
  title?: string | null
): boolean {
  const probe = `${slug ?? ""} ${title ?? ""}`.toLowerCase();
  if (!probe.trim()) return false;
  if (SPORTS_PROBE.test(probe)) return true;
  if (slug && GENERIC_PM_GAME_SLUG.test(slug)) return true;
  return false;
}

export function slugifyTeamToken(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 16);
}

export function fuzzyTeamTokenFromLabel(label: string): string | null {
  const fromCountry = fuzzyCountryNameToPm(label);
  if (fromCountry) return normalizePmTeamCode(fromCountry);
  const slug = slugifyTeamToken(label);
  return slug.length >= 2 ? slug : null;
}

/**
 * Build a ParsedGameKey without requiring Kalshi code mapping (esports / micro-props).
 * Uses Kalshi codes when available; otherwise uppercase 3-char stand-ins.
 */
export function buildLooseParsedGameKey(
  pmA: string,
  pmB: string,
  date: string
): ParsedGameKey {
  const teamA = normalizePmTeamCode(pmA);
  const teamB = normalizePmTeamCode(pmB);
  const kalshiA =
    pmCodeToKalshi(teamA) ??
    (teamA.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "AAA");
  const kalshiB =
    pmCodeToKalshi(teamB) ??
    (teamB.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "BBB");

  return {
    date: date || new Date().toISOString().slice(0, 10),
    kalshiTeamA: kalshiA,
    kalshiTeamB: kalshiB,
    pmTeamA: teamA,
    pmTeamB: teamB,
    kickoffEpochSec: null,
    kickoffKnown: false,
  };
}

export function parseGenericPmGameSlug(slug: string): ParsedPmGameSlug | null {
  const m = slug.trim().toLowerCase().match(GENERIC_PM_GAME_SLUG);
  if (!m) return null;

  const [, league, pmA, pmB, date, suffixRaw] = m;
  return {
    league,
    pmTeamA: normalizePmTeamCode(pmA),
    pmTeamB: normalizePmTeamCode(pmB),
    date,
    suffix: suffixRaw?.trim().toLowerCase() || null,
    isEsports: isEsportsLeague(league) || isEsportsProbe(slug),
  };
}

const VS_TITLE_LOOSE =
  /\b([a-z0-9][a-z0-9\s'’.\-]{1,48}?)\s+(?:vs\.?|versus|v\.?)\s+([a-z0-9][a-z0-9\s'’.\-]{1,48}?)(?:\?|$|\s*[-–—])/i;

export function parseVsTitleTeams(
  title: string
): { teamA: string; teamB: string } | null {
  const m = title.match(VS_TITLE_LOOSE);
  if (!m) return null;
  const teamA = fuzzyTeamTokenFromLabel(m[1]);
  const teamB = fuzzyTeamTokenFromLabel(m[2]);
  if (!teamA || !teamB || teamA === teamB) return null;
  return { teamA, teamB };
}

export function parseGameFromPmSlug(slug: string): ParsedGameKey | null {
  const parsed = parseGenericPmGameSlug(slug);
  if (!parsed) return null;
  return buildLooseParsedGameKey(parsed.pmTeamA, parsed.pmTeamB, parsed.date);
}

export function resolveOutcomePmFromSuffix(
  suffix: string | null,
  pmTeamA: string,
  pmTeamB: string
): string | null {
  if (!suffix) return null;
  const token = suffix.toLowerCase().trim();
  if (token === "draw" || token === "tie") return "draw";
  if (token === pmTeamA || token === pmTeamB) return token;
  if (pmTeamCodesEquivalent(token, pmTeamA)) return pmTeamA;
  if (pmTeamCodesEquivalent(token, pmTeamB)) return pmTeamB;
  return token;
}

/** Fuzzy probe: does text mention a team's PM code, slug token, or country name? */
export function probeMentionsTeamToken(
  probe: string,
  pmCode: string,
  extraLabels: string[] = []
): boolean {
  const hay = `${probe} ${extraLabels.join(" ")}`.toLowerCase();
  const code = normalizePmTeamCode(pmCode);
  if (!code) return false;

  const codePattern = new RegExp(
    `(?:^|[^a-z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`,
    "i"
  );
  if (codePattern.test(hay)) return true;

  const slug = slugifyTeamToken(code);
  if (slug.length >= 3) {
    const slugPattern = new RegExp(
      `(?:^|[^a-z0-9])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`,
      "i"
    );
    if (slugPattern.test(hay)) return true;
  }

  for (const label of extraLabels) {
    const token = slugifyTeamToken(label);
    if (token.length >= 3) {
      const labelPattern = new RegExp(
        `(?:^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`,
        "i"
      );
      if (labelPattern.test(hay)) return true;
    }
  }

  return false;
}
