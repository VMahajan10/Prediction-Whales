import { NextRequest, NextResponse } from "next/server";
import { runEvPipeline } from "@/lib/evPipeline/pipeline";
import {
  runWithPipelineLock,
  writePipelineMeta,
} from "@/lib/evPipeline/redisCache";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * EV pipeline cron orchestrator.
 *
 * Trigger:
 * - Vercel Cron: vercel.json path /api/cron/ev-pipeline (e.g. every minute)
 * - Manual: GET /api/cron/ev-pipeline?secret=$CRON_SECRET
 *
 * Stages (see lib/evPipeline/pipeline.ts):
 * 1. ingestOrderBooks  — Redis cache PM/Kalshi mids (10s TTL)
 * 2. matchMarkets           — upsert market_mappings (string + vector + LLM)
 * 2.5 refreshConsensusIndex — rebuild sportsbook consensus + prop alias keys
 * 2.75 ingestRagContext    — warm similar-market index + odds history for RAG
 * 3. computePTrue      — insert true_probabilities + cache p_true
 * 3.5 warmWhaleFeedEv  — precompute trade EV for recent whale-feed assets
 * 4. computeTraderEv   — upsert trader_ev_analytics + cache wallet rollups
 */
export async function GET(request: NextRequest) {
  const secret =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.nextUrl.searchParams.get("secret");

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && secret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const lockResult = await runWithPipelineLock(runId, async () => {
      const result = await runEvPipeline(runId);

      await writePipelineMeta({
        runId,
        finishedAt: new Date().toISOString(),
        stages: result.stages,
      });

      return result;
    });

    if (!lockResult.acquired) {
      return NextResponse.json(
        { ok: false, error: "Pipeline already running", runId },
        { status: 409 },
      );
    }

    const result = lockResult.value;
    const allOk = Object.values(result.stages).every((s) => s.ok);

    console.log("Pipeline processing complete, sending response...");

    return NextResponse.json(
      {
        ok: allOk,
        runId,
        durationMs: Date.now() - startedAt,
        stages: result.stages,
      },
      { status: allOk ? 200 : 207 },
    );
  } catch (err) {
    console.error("[cron/ev-pipeline]", err);
    return NextResponse.json(
      {
        ok: false,
        runId,
        error: err instanceof Error ? err.message : "Pipeline failed",
      },
      { status: 500 },
    );
  }
}

/** Optional POST for manual reruns with JSON body { "stages": ["matchMarkets"] } */
export async function POST(request: NextRequest) {
  return GET(request);
}
