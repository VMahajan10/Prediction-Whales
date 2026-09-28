/** Approved plain-English translations paired with wallet AVG EV in post copy. */
export const EV_GLOSSES = [
  "profitable on average",
  "wins at the right price",
  "gets in at better prices than the market",
  "paid for disagreeing with the crowd",
  "makes money per bet, not just wins often",
] as const;

export type EvGloss = (typeof EV_GLOSSES)[number];

const EV_GLOSS_SET = new Set<string>(EV_GLOSSES);

export function isEvGloss(value: string | null | undefined): value is EvGloss {
  return value != null && EV_GLOSS_SET.has(value);
}

export function formatAvgEvPercent(avgEvDecimal: number): string {
  const pct = avgEvDecimal * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

/** AVG EV display percent bound to a gloss — never bare `{avg_ev}`. */
export function formatBoundAvgEv(
  avgEvDecimal: number,
  gloss: EvGloss
): string {
  return `${formatAvgEvPercent(avgEvDecimal)} AVG EV — ${gloss}`;
}

/**
 * Phrase after "they …" / "as they …" / "historically they …".
 * Must be grammatical (verb or "are …" adjective phrase).
 */
const EV_GLOSS_THEY: Record<EvGloss, string> = {
  "profitable on average": "are profitable on average",
  "wins at the right price": "win at the right price",
  "gets in at better prices than the market":
    "get in at better prices than the market",
  "paid for disagreeing with the crowd":
    "get paid for disagreeing with the crowd",
  "makes money per bet, not just wins often":
    "make money per bet, not just win often",
};

/** Phrase after "still …" (progressive / participial). */
const EV_GLOSS_PROGRESSIVE: Record<EvGloss, string> = {
  "profitable on average": "profitable on average",
  "wins at the right price": "winning at the right price",
  "gets in at better prices than the market":
    "getting in at better prices than the market",
  "paid for disagreeing with the crowd":
    "getting paid for disagreeing with the crowd",
  "makes money per bet, not just wins often":
    "making money per bet, not just winning often",
};

export function evGlossForThey(gloss: EvGloss): string {
  return EV_GLOSS_THEY[gloss];
}

export function progressiveEvGloss(gloss: EvGloss): string {
  return EV_GLOSS_PROGRESSIVE[gloss];
}

export interface SelectEvGlossParams {
  /** Prior gloss — excluded so consecutive posts never repeat. */
  excludeGloss?: string | null;
  random?: () => number;
}

/**
 * Pick the next EV gloss, filtering out `excludeGloss` when other options exist.
 */
export function selectEvGloss(params: SelectEvGlossParams = {}): EvGloss {
  const random = params.random ?? Math.random;
  const exclude = params.excludeGloss?.trim();

  let pool: readonly EvGloss[] = EV_GLOSSES;
  if (exclude && isEvGloss(exclude)) {
    const filtered = EV_GLOSSES.filter((gloss) => gloss !== exclude);
    if (filtered.length > 0) {
      pool = filtered;
    }
  }

  const index = Math.floor(random() * pool.length);
  return pool[index] ?? EV_GLOSSES[0];
}
