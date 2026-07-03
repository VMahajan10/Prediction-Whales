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
  ALG: "dza",
  IRQ: "irq",
  SEN: "sen",
  RSA: "rsa",
  NED: "ned",
  SUI: "sui",
  CHE: "sui",
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

/**
 * Verified PM slug codes that differ from the canonical PM code but map to
 * the same Kalshi ticker (same country — not fuzzy matching).
 */
const PM_SLUG_TO_KALSHI: Record<string, string> = {
  ury: "URU", // Uruguay — PM slug uses ury, Kalshi uses URU
  cvi: "CPV", // Cape Verde — PM slug uses cvi, Kalshi uses CPV
};

/**
 * Verified PM slug / ISO / exchange tokens → canonical PM code used across
 * the pipeline (sportsbook names, Kalshi tickers, cross-market index keys).
 */
const PM_CODE_CANONICAL: Record<string, string> = {
  ury: "uru",
  cvi: "cpv",
  /** Switzerland — PM fifwc slugs use ISO alpha-3 `che`, internal code `sui`. */
  che: "sui",
  /** Algeria — PM fifwc slugs use `alg`, internal / Kalshi code `dza`. */
  alg: "dza",
  /** Iran — Kalshi `IRI` vs PM `irn`. */
  iri: "irn",
  /** Germany ISO alpha-3. */
  deu: "ger",
  /** Costa Rica short slug. */
  cos: "crc",
};

const unmatchedKalshi = new Set<string>();
const unmatchedPm = new Set<string>();

/** Normalize PM team codes for equivalence checks (verified aliases only). */
export function normalizePmTeamCode(code: string): string {
  const lower = code.trim().toLowerCase();
  if (!lower) return lower;
  return PM_CODE_CANONICAL[lower] ?? lower;
}

/** True when two PM / slug / ISO tokens refer to the same team. */
export function pmTeamCodesEquivalent(a: string, b: string): boolean {
  return normalizePmTeamCode(a) === normalizePmTeamCode(b);
}

/** PM event-slug tokens to try when fetching Gamma (verified variants only). */
export function pmEventSlugCodeVariants(code: string): string[] {
  const lower = code.toLowerCase();
  const variants = new Set<string>([lower]);
  if (lower === "cpv" || lower === "cvi") {
    variants.add("cpv");
    variants.add("cvi");
  }
  if (lower === "uru" || lower === "ury") {
    variants.add("uru");
    variants.add("ury");
  }
  return Array.from(variants);
}

export function kalshiCodeToPm(code: string): string | null {
  const upper = code.trim().toUpperCase();
  if (KALSHI_TO_PM[upper]) return KALSHI_TO_PM[upper];
  const canonical = normalizePmTeamCode(upper.toLowerCase());
  if (PM_TO_KALSHI[canonical] || PM_SLUG_TO_KALSHI[canonical]) return canonical;
  if (canonical.length === 3) return canonical;
  unmatchedKalshi.add(upper);
  return null;
}

export function pmCodeToKalshi(code: string): string | null {
  const canonical = normalizePmTeamCode(code.trim());
  if (PM_SLUG_TO_KALSHI[canonical]) return PM_SLUG_TO_KALSHI[canonical];
  if (PM_TO_KALSHI[canonical]) return PM_TO_KALSHI[canonical];
  if (canonical.length === 3) return canonical.toUpperCase();
  unmatchedPm.add(canonical);
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
