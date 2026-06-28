import { NextRequest, NextResponse } from "next/server";
import { isEmbeddingConfigured } from "@/lib/evPipeline/embeddings";
import { runMarketMapping } from "@/lib/evPipeline/mapMarkets";
import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorize(request: NextRequest): boolean {
  const secret =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.nextUrl.searchParams.get("secret");

  const expected = process.env.CRON_SECRET ?? process.env.MAP_MARKETS_SECRET;
  if (!expected) return true;
  return secret === expected;
}

/**
 * Cross-market mapping pipeline — extract, normalize, embed, match, persist.
 *
 * GET /api/ev/map-markets
 *   ?threshold=0.85
 *   &pmLimit=200
 *   &kalshiPages=5
 *   &dryRun=1          (skip DB writes)
 *   &secret=...
 *
 * Requires OPENAI_API_KEY. DATABASE_URL optional when dryRun=1.
 */
export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isEmbeddingConfigured()) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 },
    );
  }

  const params = request.nextUrl.searchParams;
  const threshold = Number(params.get("threshold") ?? "0.75");
  const pmLimit = Number(params.get("pmLimit") ?? "400");
  const kalshiPages = Number(params.get("kalshiPages") ?? "12");
  const dryRun = params.get("dryRun") === "1" || params.get("dryRun") === "true";
  const persist = !dryRun;

  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    return NextResponse.json(
      { error: "threshold must be between 0 and 1" },
      { status: 400 },
    );
  }

  if (persist && !isDatabaseEnabled()) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured (use dryRun=1 to test without DB)" },
      { status: 503 },
    );
  }

  try {
    const result = await runMarketMapping({
      similarityThreshold: threshold,
      polymarketLimit: Number.isFinite(pmLimit) ? pmLimit : 400,
      kalshiMaxPages: Number.isFinite(kalshiPages) ? kalshiPages : 12,
      persist,
    });

    if (result.failures.length > 0) {
      console.warn(
        `[ev/map-markets] completed with ${result.failures.length} failure(s):`,
        result.failures
      );
    }

    return NextResponse.json(result, {
      status:
        result.matchedCount > 0 || result.failures.length === 0 ? 200 : 207,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Mapping pipeline failed";
    console.error("[ev/map-markets] fatal:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
