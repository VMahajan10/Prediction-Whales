import { normalizePmTeamCode, pmCodeToKalshi, pmTeamCodesEquivalent } from "@/lib/teamCodes";
import type { OutcomeSide, ParsedGameKey } from "@/lib/crossMarketEv";

/** English country names → Polymarket fifwc slug codes (deterministic). */
export const COUNTRY_NAME_TO_PM: Record<string, string> = {
  portugal: "prt",
  colombia: "col",
  france: "fra",
  norway: "nor",
  spain: "esp",
  uruguay: "uru",
  england: "eng",
  germany: "ger",
  brazil: "bra",
  argentina: "arg",
  mexico: "mex",
  usa: "usa",
  "united states": "usa",
  japan: "jpn",
  korea: "kor",
  "south korea": "kor",
  netherlands: "ned",
  belgium: "bel",
  croatia: "cro",
  switzerland: "sui",
  canada: "can",
  australia: "aus",
  ghana: "gha",
  senegal: "sen",
  morocco: "mar",
  tunisia: "tun",
  egypt: "egy",
  iran: "irn",
  "saudi arabia": "ksa",
  qatar: "qat",
  ecuador: "ecu",
  cameroon: "cmr",
  poland: "pol",
  serbia: "srb",
  denmark: "den",
  sweden: "swe",
  scotland: "sco",
  wales: "wal",
  panama: "pan",
  paraguay: "par",
  chile: "chi",
  austria: "aut",
  ukraine: "ukr",
  turkey: "tur",
  "ivory coast": "civ",
  "cote d'ivoire": "civ",
  "côte d'ivoire": "civ",
  algeria: "dza",
  nigeria: "nga",
  "new zealand": "nzl",
  "south africa": "rsa",
  jordan: "jor",
  uzbekistan: "uzb",
  iraq: "irq",
  "cape verde": "cpv",
  haiti: "hti",
  curacao: "cuw",
  "curaçao": "cuw",
  bolivia: "bol",
  peru: "per",
  costa: "crc",
  "costa rica": "crc",
  jamaica: "jam",
  honduras: "hon",
  slovakia: "svk",
  slovenia: "svn",
  "czech republic": "cze",
  czechia: "cze",
};

/** Extra search tokens for slug / ISO matching (canonical PM code → aliases). */
const PM_CODE_SEARCH_ALIASES: Record<string, string[]> = {
  sui: ["che", "switzerland"],
  dza: ["alg", "algeria"],
  irn: ["iri", "iran"],
  cpv: ["cvi", "cape verde"],
  uru: ["ury", "uruguay"],
  crc: ["cos", "costa rica"],
  ger: ["deu", "germany"],
};

function normalizeCountryToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Map any country name, ISO slug, or exchange code to canonical PM code. */
export function countryNameToPm(name: string): string | null {
  const key = normalizeCountryToken(name);
  if (!key) return null;

  if (COUNTRY_NAME_TO_PM[key]) return normalizePmTeamCode(COUNTRY_NAME_TO_PM[key]);

  const compact = key.replace(/\s+/g, "");
  for (const [alias, pm] of Object.entries(COUNTRY_NAME_TO_PM)) {
    if (alias.replace(/\s+/g, "") === compact) {
      return normalizePmTeamCode(pm);
    }
  }

  if (/^[a-z]{3}$/i.test(key)) {
    const fromCode = normalizePmTeamCode(key);
    if (pmCodeToKalshi(fromCode)) return fromCode;
  }

  return null;
}

/** Looser match — e.g. "Switzerland National Team" / "CHE" → sui */
export function fuzzyCountryNameToPm(name: string): string | null {
  const direct = countryNameToPm(name);
  if (direct) return direct;

  const cleaned = normalizeCountryToken(
    name.replace(/\b(national team|men|women|fc|cf|sc|the)\b/gi, " ")
  );
  if (cleaned !== normalizeCountryToken(name)) {
    const fromCleaned = countryNameToPm(cleaned);
    if (fromCleaned) return fromCleaned;
  }

  const key = normalizeCountryToken(name);
  for (const [alias, pm] of Object.entries(COUNTRY_NAME_TO_PM)) {
    if (key.startsWith(alias) || alias.startsWith(key)) {
      return normalizePmTeamCode(pm);
    }
    if (key.includes(alias) || alias.includes(key)) {
      return normalizePmTeamCode(pm);
    }
  }

  for (const [canonical, aliases] of Object.entries(PM_CODE_SEARCH_ALIASES)) {
    if (aliases.some((alias) => key === alias || key.includes(alias))) {
      return canonical;
    }
  }

  return null;
}

export function pmCodeToCountryNames(pmCode: string): string[] {
  const code = normalizePmTeamCode(pmCode);
  const names = Object.entries(COUNTRY_NAME_TO_PM)
    .filter(([, pm]) => normalizePmTeamCode(pm) === code)
    .map(([name]) => name);
  const aliases = PM_CODE_SEARCH_ALIASES[code] ?? [];
  return Array.from(new Set([...names, ...aliases, code]));
}

export function teamsMatchGame(
  game: ParsedGameKey,
  teamA: string,
  teamB: string
): boolean {
  const pair = new Set([
    normalizePmTeamCode(game.pmTeamA),
    normalizePmTeamCode(game.pmTeamB),
  ]);
  return (
    pair.has(normalizePmTeamCode(teamA)) &&
    pair.has(normalizePmTeamCode(teamB))
  );
}

export function gamesReferToSameMatch(
  a: ParsedGameKey,
  b: ParsedGameKey,
  options?: { dateToleranceDays?: number }
): boolean {
  const tolerance = options?.dateToleranceDays ?? 1;
  return (
    datesWithinTolerance(a.date, b.date, tolerance) &&
    teamsMatchGame(a, b.pmTeamA, b.pmTeamB)
  );
}

function datesWithinTolerance(
  a: string,
  b: string,
  toleranceDays: number
): boolean {
  if (a === b) return true;
  if (toleranceDays <= 0) return false;
  const pa = Date.parse(`${a}T12:00:00Z`);
  const pb = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return false;
  return Math.abs(pa - pb) <= toleranceDays * 86_400_000;
}

export function adjacentDates(date: string): string[] {
  const anchor = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(anchor)) return [date];
  const prev = new Date(anchor - 86_400_000).toISOString().slice(0, 10);
  const next = new Date(anchor + 86_400_000).toISOString().slice(0, 10);
  return [date, prev, next];
}

export function outcomeForWinner(
  game: ParsedGameKey,
  winnerPm: string
): OutcomeSide | null {
  const winner = normalizePmTeamCode(winnerPm);
  if (pmTeamCodesEquivalent(game.pmTeamA, winner)) return "team_a";
  if (pmTeamCodesEquivalent(game.pmTeamB, winner)) return "team_b";
  return null;
}

export function findGameInIndex(
  index: Map<string, { game: ParsedGameKey }>,
  date: string,
  teamA: string,
  teamB: string,
  options?: { dateToleranceDays?: number }
): ParsedGameKey | null {
  const tolerance = options?.dateToleranceDays ?? 0;
  for (const entry of Array.from(index.values())) {
    if (
      datesWithinTolerance(entry.game.date, date, tolerance) &&
      teamsMatchGame(entry.game, teamA, teamB)
    ) {
      return entry.game;
    }
  }
  return null;
}
