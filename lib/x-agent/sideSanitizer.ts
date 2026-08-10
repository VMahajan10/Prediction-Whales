/** Max length for a clean named `{side}` slot in post templates. */
export const MAX_TEMPLATE_SIDE_LENGTH = 30;

const BOUGHT_VERB_PREFIX =
  /^(?:bought|sold)\s+(?:yes|no)\.?\s*/i;
const BOUGHT_NAMED_PREFIX = /^(?:bought|sold)\s+/i;
const BACKING_PREFIX = /^backing\s+/i;

const RUN_ON_DESCRIPTION_RE =
  /\b(is competing|will win|to win|in a match|prediction market|according to|currently|this season)\b/i;

/**
 * Normalize a market position into a short named outcome for `{side}`.
 * Returns null when the value is a raw verb phrase or run-on market copy.
 */
export function sanitizeTemplateSide(
  raw: string | null | undefined
): string | null {
  if (!raw?.trim()) return null;

  let side = raw.trim();
  side = side.replace(BOUGHT_VERB_PREFIX, "");
  side = side.replace(BACKING_PREFIX, "");
  side = side.replace(BOUGHT_NAMED_PREFIX, "");
  side = side.replace(/^["']|["']$/g, "").trim();

  if (!side) return null;
  if (/^(yes|no|true|false)$/i.test(side)) return null;
  if (side.length > MAX_TEMPLATE_SIDE_LENGTH) return null;
  if (RUN_ON_DESCRIPTION_RE.test(side)) return null;
  if (/\.\s/.test(side) || side.includes("...")) return null;

  return side;
}

/**
 * Format an explicit NO position when only the subject team is known.
 * Example: team "San Diego FC" → "San Diego FC (NO)".
 */
export function formatExplicitNoOutcome(teamName: string): string | null {
  const cleaned = sanitizeTemplateSide(teamName);
  if (!cleaned) return null;
  const label = `${cleaned} (NO)`;
  return label.length <= MAX_TEMPLATE_SIDE_LENGTH + 6 ? label : null;
}
