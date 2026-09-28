/**
 * Read-only V1–V8 template preview — no X API, Telegram, or DB writes.
 * npx tsx --tsconfig tsconfig.json scripts/preview-v1-v8-template-drafts.ts
 */
import "../tests/preload-env";
import { sanitizePostDraft } from "@/lib/templates/postTemplates";
import {
  getLastTemplateCopySource,
  getTemplateFamilyCopy,
  inspectRuntimeTemplateVariants,
  refreshTemplateCopyCache,
} from "@/lib/templates/templateCopyLoader";
import { TEMPLATE_FAMILIES } from "@/lib/templates/templateTypes";
import type { PostTemplateInputs } from "@/lib/templates/templateTypes";
import type { TemplateFamily } from "@/lib/templates/templateTypes";
import {
  assertRequiredBaseSlots,
  buildSlotValues,
  hasAvgEv,
  hasWinRateCredibility,
  PostTemplateError,
  renderVariantCopy,
} from "@/lib/templates/templateRender";
import { MIN_TEMPLATE_RESOLVED_BETS } from "@/lib/templates/templatesDoc";
import { sanitizeTemplateSide } from "@/lib/x-agent/sideSanitizer";

const SECRET_CONTEXT = "UNAPPROVED_CONTEXT_SHOULD_NOT_APPEAR";

function baseMock(overrides: Partial<PostTemplateInputs> = {}): PostTemplateInputs {
  return {
    whale: "CrimsonVanguard",
    side: "Zhizhen Zhang",
    entry: 64,
    now: 64,
    avg_ev: 0.12,
    marketPlain: "to win the Round of 16 match",
    category: "Champions League",
    stakeNotional: 52_000,
    avgStakeNotional: 8_000,
    postedCount30d: 0,
    resolvedBetsCount: 1_240,
    winRate: 0.68,
    agoMinutes: 8,
    context: SECRET_CONTEXT,
    ...overrides,
  };
}

const SCENARIO_BY_FAMILY: Record<
  TemplateFamily,
  { label: string; inputs: PostTemplateInputs; resolutionReceipt?: boolean }
> = {
  V1: { label: "Default live move (V1 always eligible)", inputs: baseMock() },
  V2: {
    label: "Track record first (resolved + win rate / avg EV)",
    inputs: baseMock({ entry: 58, now: 58, postedCount30d: 0 }),
  },
  V3: {
    label: "Edge-left: price moved (entry 52¢ → now 58¢)",
    inputs: baseMock({ entry: 52, now: 58, agoMinutes: 6 }),
  },
  V4: {
    label: "Conviction: stake > avg stake (~$8K avg)",
    inputs: baseMock({
      entry: 61,
      now: undefined,
      stakeNotional: 52_000,
      avgStakeNotional: 8_000,
      postedCount30d: 0,
    }),
  },
  V5: {
    label: "Contrarian: entry 35¢ (<40¢)",
    inputs: baseMock({
      entry: 35,
      now: 41,
      postedCount30d: 0,
      avgStakeNotional: undefined,
    }),
  },
  V6: {
    label: "Repeat character: postedCount30d >= 2",
    inputs: baseMock({
      entry: 55,
      now: 55,
      postedCount30d: 2,
      category: "Champions League",
      avgStakeNotional: undefined,
    }),
  },
  V7: {
    label: "Quiet signal: now within 2¢ of entry (64¢ / 65¢)",
    inputs: baseMock({
      entry: 64,
      now: 65,
      postedCount30d: 0,
      avgStakeNotional: undefined,
    }),
  },
  V8: {
    label: "Resolution receipt: prior published trade resolved YES",
    inputs: baseMock({ gainCents: 36, entry: 64, now: 100 }),
    resolutionReceipt: true,
  },
};

function countHashtags(text: string): number {
  return (text.match(/#\w+/gi) ?? []).length;
}

function credibilityPath(
  inputs: PostTemplateInputs,
  variantCred?: string
): string {
  const floor = MIN_TEMPLATE_RESOLVED_BETS;
  if (
    variantCred === "avg_ev" ||
    (variantCred !== "win_rate" && hasAvgEv(inputs, floor))
  ) {
    if (hasAvgEv(inputs, floor)) return "avg_ev";
  }
  if (hasWinRateCredibility(inputs, floor)) return "win_rate + resolved";
  return "n/a";
}

function inputSlotsSummary(inputs: PostTemplateInputs): Record<string, unknown> {
  return {
    whale: inputs.whale,
    side: inputs.side,
    entry: inputs.entry,
    now: inputs.now ?? null,
    stakeNotional: inputs.stakeNotional,
    avgStakeNotional: inputs.avgStakeNotional ?? null,
    avg_ev: inputs.avg_ev ?? null,
    winRate: inputs.winRate ?? null,
    resolvedBetsCount: inputs.resolvedBetsCount ?? null,
    postedCount30d: inputs.postedCount30d ?? null,
    category: inputs.category ?? inputs.marketPlain ?? null,
    agoMinutes: inputs.agoMinutes ?? null,
    gainCents: inputs.gainCents ?? null,
  };
}

function finalizeDraft(
  raw: string,
  slots: ReturnType<typeof buildSlotValues>["slots"]
): string {
  let out = sanitizePostDraft(raw);
  if (
    slots.hashtag &&
    !out.toLowerCase().includes(slots.hashtag.toLowerCase())
  ) {
    out = sanitizePostDraft(`${out} ${slots.hashtag}`);
  }
  return out;
}

async function main(): Promise<void> {
  const templateSource = await refreshTemplateCopyCache({ readOnly: true });
  console.log(`TEMPLATE_SOURCE=${getLastTemplateCopySource()}\n`);
  console.log("=== V1–V8 TEMPLATE PREVIEWS (read-only, no X API) ===\n");

  const allDrafts: string[] = [];

  for (const family of TEMPLATE_FAMILIES) {
    const familyDef = getTemplateFamilyCopy(family);
    const scenario = SCENARIO_BY_FAMILY[family];
    console.log(`\n######## ${family} ########`);
    console.log(`Scenario: ${scenario.label}\n`);

    const { slots, evGloss } = buildSlotValues(
      scenario.inputs,
      () => 0.5,
      null
    );

    for (const variant of familyDef.variants) {
      const sentenceOrderIndex = 0;
      let rendered: string;
      let glossUsed: string | null = null;

      try {
        const { text } = renderVariantCopy(variant, slots, sentenceOrderIndex);
        rendered = finalizeDraft(text, slots);
        const usesAvg =
          variant.credibility === "avg_ev" ||
          variant.required.includes("avgEv");
        glossUsed = usesAvg ? evGloss : null;
      } catch (e) {
        rendered = `[RENDER FAILED: ${e instanceof Error ? e.message : e}]`;
      }

      const path = credibilityPath(scenario.inputs, variant.credibility);
      const chars = rendered.length;
      const hashtags = countHashtags(rendered);

      console.log(`--- ${family}-${variant.id} ---`);
      console.log(`Family: ${family}`);
      console.log(`Variant ID: ${family}-${variant.id}`);
      console.log(`Eligibility scenario: ${scenario.label}`);
      console.log(
        `Input slots: ${JSON.stringify(inputSlotsSummary(scenario.inputs), null, 2)}`
      );
      console.log(`Credibility path: ${path}`);
      console.log(`EV gloss: ${glossUsed ?? "n/a"}`);
      console.log(`Sentence order index: ${sentenceOrderIndex}`);
      console.log(`Character count: ${chars}`);
      console.log(`Hashtag count: ${hashtags}`);
      console.log(`URL present: ${/https?:\/\//i.test(rendered) ? "YES" : "NO"}`);
      console.log(`Siren emoji present: ${rendered.includes("🚨") ? "YES" : "NO"}`);
      console.log(`Rendered final copy:\n${rendered}\n`);
      allDrafts.push(`${family}-${variant.id}: ${rendered}`);
    }
  }

  console.log("\n=== FAIL-CLOSED (NO DRAFT) EXAMPLES ===\n");

  const failCases: Array<{ name: string; run: () => void }> = [
    {
      name: "anonymous whale",
      run: () =>
        assertRequiredBaseSlots(
          baseMock({ anonymousWhale: true }),
          MIN_TEMPLATE_RESOLVED_BETS
        ),
    },
    {
      name: "missing side (empty / untranslatable)",
      run: () => {
        assertRequiredBaseSlots(baseMock({ side: "" }), MIN_TEMPLATE_RESOLVED_BETS);
      },
    },
    {
      name: "missing entry",
      run: () =>
        assertRequiredBaseSlots(
          baseMock({ entry: Number.NaN }),
          MIN_TEMPLATE_RESOLVED_BETS
        ),
    },
    {
      name: "missing credibility stat (no avg_ev, no win_rate)",
      run: () =>
        assertRequiredBaseSlots(
          baseMock({ avg_ev: undefined, winRate: undefined }),
          MIN_TEMPLATE_RESOLVED_BETS
        ),
    },
    {
      name: "win_rate without resolved count",
      run: () =>
        assertRequiredBaseSlots(
          baseMock({
            avg_ev: undefined,
            winRate: 0.68,
            resolvedBetsCount: 0,
          }),
          MIN_TEMPLATE_RESOLVED_BETS
        ),
    },
    {
      name: "untranslatable side (sanitizer rejects)",
      run: () => {
        if (sanitizeTemplateSide("bought no. San Diego FC is competing in a match")) {
          throw new Error("UNEXPECTED: side accepted");
        }
        throw new PostTemplateError("side(named)");
      },
    },
  ];

  for (const { name, run } of failCases) {
    let outcome = "NO DRAFT";
    try {
      run();
      outcome = "UNEXPECTED DRAFT PRODUCED";
    } catch (e) {
      outcome = `NO DRAFT — ${e instanceof PostTemplateError ? e.message : String(e)}`;
    }
    console.log(`• ${name}: ${outcome}`);
  }

  console.log("\n=== RUNTIME TEMPLATE TABLE (read-only) ===");
  const runtime = await inspectRuntimeTemplateVariants();
  console.log(
    `RUNTIME_TEMPLATE_TABLE_EXISTS: ${runtime.tableQueryable ? "YES" : "NO"}`
  );
  console.log(`RUNTIME_TEMPLATE_ROW_COUNT: ${runtime.rowCount}`);
  console.log(
    `RUNTIME_DATA_MATCHES_CORRECTED_DEFAULTS: ${
      runtime.rowCount === 0
        ? "NOT_APPLICABLE"
        : runtime.matchesBundledDefaults
          ? "YES"
          : "NO"
    }`
  );
  console.log(
    `RUNTIME_DATA_UPDATE_WILL_BE_REQUIRED: ${
      runtime.rowCount > 0 && !runtime.matchesBundledDefaults ? "YES" : "NO"
    }`
  );

  console.log("\n=== ALL 24 RENDERED DRAFTS (summary) ===\n");
  for (const line of allDrafts) {
    console.log(line);
  }

  if (templateSource !== getLastTemplateCopySource()) {
    console.warn("Template source mismatch after load");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
