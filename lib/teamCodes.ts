/** Kalshi 3-letter ticker codes → Polymarket fifwc slug codes. */
const KALSHI_TO_PM: Record<string, string> = {
  POR: "prt",
  COD: "cdr",
  IRI: "irn",
  CUW: "cuw",
  CPV: "cpv",
  HTI: "hti",
  KSA: "ksa",
  NZL: "nzl",
  EGY: "egy",
  DZA: "dza",
  IRQ: "irq",
  SEN: "sen",
  RSA: "rsa",
  NED: "ned",
  SUI: "sui",
  TUR: "tur",
  PAR: "par",
  AUS: "aus",
  USA: "usa",
  MEX: "mex",
  KOR: "kor",
  JPN: "jpn",
  GER: "ger",
  FRA: "fra",
  ESP: "esp",
  ENG: "eng",
  CRO: "cro",
  GHA: "gha",
  PAN: "pan",
  UZB: "uzb",
  COL: "col",
  CAN: "can",
  QAT: "qat",
  CZE: "cze",
  BRA: "bra",
  MAR: "mar",
  ARG: "arg",
  NOR: "nor",
  SWE: "swe",
  BEL: "bel",
  ECU: "ecu",
  URU: "uru",
  TUN: "tun",
  JOR: "jor",
  AUT: "aut",
  BIH: "bih",
  SCO: "sco",
  CIV: "civ",
  IRN: "irn",
};

const PM_TO_KALSHI: Record<string, string> = Object.fromEntries(
  Object.entries(KALSHI_TO_PM).map(([k, v]) => [v, k])
);

const unmatchedKalshi = new Set<string>();
const unmatchedPm = new Set<string>();

export function kalshiCodeToPm(code: string): string | null {
  const upper = code.toUpperCase();
  if (KALSHI_TO_PM[upper]) return KALSHI_TO_PM[upper];
  const lower = upper.toLowerCase();
  if (lower.length === 3) return lower;
  unmatchedKalshi.add(upper);
  return null;
}

export function pmCodeToKalshi(code: string): string | null {
  const lower = code.toLowerCase();
  if (PM_TO_KALSHI[lower]) return PM_TO_KALSHI[lower];
  const upper = lower.toUpperCase();
  if (upper.length === 3) return upper;
  unmatchedPm.add(lower);
  return null;
}

export function getUnmatchedTeamCodes(): {
  kalshi: string[];
  polymarket: string[];
} {
  return {
    kalshi: Array.from(unmatchedKalshi).sort(),
    polymarket: Array.from(unmatchedPm).sort(),
  };
}

export function clearUnmatchedTeamCodeLog(): void {
  unmatchedKalshi.clear();
  unmatchedPm.clear();
}
