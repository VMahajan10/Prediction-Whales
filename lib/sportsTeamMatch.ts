import { normalizePmTeamCode, pmCodeToKalshi } from "@/lib/teamCodes";
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

function normalizeCountryToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function countryNameToPm(name: string): string | null {
  const key = normalizeCountryToken(name);
  if (COUNTRY_NAME_TO_PM[key]) return COUNTRY_NAME_TO_PM[key];
  const compact = key.replace(/\s+/g, "");
  for (const [alias, pm] of Object.entries(COUNTRY_NAME_TO_PM)) {
    if (alias.replace(/\s+/g, "") === compact) return pm;
  }
  const asCode = key.length === 3 ? key : null;
  if (asCode && pmCodeToKalshi(asCode)) return asCode;
  return null;
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
  if (normalizePmTeamCode(game.pmTeamA) === winner) return "team_a";
  if (normalizePmTeamCode(game.pmTeamB) === winner) return "team_b";
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
