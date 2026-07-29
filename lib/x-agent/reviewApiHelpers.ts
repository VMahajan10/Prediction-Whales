import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import { buildDecisionConflictMessage } from "@/lib/x-agent/reviewDecision";
import { NextResponse } from "next/server";

export function reviewDecisionConflictResponse(
  current: XPostQueue
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      conflict: true,
      error: buildDecisionConflictMessage(current.decidedBy),
      status: current.status,
      decidedBy: current.decidedBy ?? null,
      decidedAt: current.decidedAt?.toISOString() ?? null,
    },
    { status: 409 }
  );
}

export function reviewDecisionConflictHtml(
  current: XPostQueue
): string {
  return buildDecisionConflictMessage(current.decidedBy);
}
