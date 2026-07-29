import {
  finalizeQueueByIdIfPending,
  findQueueById,
} from "@/lib/x-agent/reviewDb";
import { POST_STATUS } from "@/lib/x-agent/postStatus";
import {
  buildScheduleApprovalApiMessage,
  formatScheduledClockTime,
} from "@/lib/x-agent/scheduleMessages";
import {
  getRandomScheduledTime,
  resolveImmediateScheduledAt,
  resolveScheduledAt,
} from "@/lib/x-agent/reviewSchedule";
import {
  normalizeDecidedBy,
} from "@/lib/x-agent/reviewDecision";
import { reviewDecisionConflictResponse } from "@/lib/x-agent/reviewApiHelpers";
import { sanitizeXPostCopy } from "@/lib/x-agent/templates";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type ReviewEditAction = "approve" | "reject";
type ScheduleMode = "default" | "immediate" | "custom";

interface ReviewEditBody {
  id?: string;
  updatedText?: string;
  action?: string;
  scheduledAt?: string;
  scheduleMode?: string;
  decidedBy?: string;
}

function parseAction(value: string | undefined): ReviewEditAction | null {
  if (value === "approve" || value === "reject") return value;
  return null;
}

function parseScheduleMode(value: string | undefined): ScheduleMode {
  if (value === "immediate" || value === "custom") return value;
  return "default";
}

export async function POST(request: NextRequest) {
  let body: ReviewEditBody;
  try {
    body = (await request.json()) as ReviewEditBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const id = body.id?.trim();
  const action = parseAction(body.action);
  const updatedText =
    typeof body.updatedText === "string" ? body.updatedText : "";
  const scheduleMode = parseScheduleMode(body.scheduleMode);
  const decidedBy = normalizeDecidedBy(body.decidedBy);

  if (!id || !action) {
    return NextResponse.json(
      { ok: false, error: "id and action=approve|reject are required" },
      { status: 400 }
    );
  }

  try {
    const item = await findQueueById(id);
    if (!item) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    if (action === "reject") {
      const result = await finalizeQueueByIdIfPending(id, {
        status: "KILLED",
        decidedBy,
      });

      if (result.ok) {
        return NextResponse.json({
          ok: true,
          status: result.row.status,
          tradeId: result.row.tradeId,
          decidedBy: result.row.decidedBy,
          decidedAt: result.row.decidedAt?.toISOString() ?? null,
        });
      }

      if (result.conflict && result.current) {
        return reviewDecisionConflictResponse(result.current);
      }

      return NextResponse.json(
        { ok: false, error: "Database unavailable" },
        { status: 503 }
      );
    }

    const copyText = sanitizeXPostCopy(updatedText);
    if (!copyText) {
      return NextResponse.json(
        { ok: false, error: "Post copy is empty after safety sanitization" },
        { status: 400 }
      );
    }

    const defaultScheduledAt = getRandomScheduledTime();
    const scheduledAt =
      scheduleMode === "immediate"
        ? resolveImmediateScheduledAt()
        : scheduleMode === "custom"
          ? resolveScheduledAt(body.scheduledAt, defaultScheduledAt)
          : defaultScheduledAt;

    const result = await finalizeQueueByIdIfPending(id, {
      copyText,
      status: POST_STATUS.SCHEDULED,
      scheduledFor: scheduledAt,
      decidedBy,
    });

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        status: result.row.status,
        tradeId: result.row.tradeId,
        copyText: result.row.copyText,
        scheduledAt: scheduledAt.toISOString(),
        scheduledTimeLabel: formatScheduledClockTime(scheduledAt),
        message: buildScheduleApprovalApiMessage(scheduledAt),
        decidedBy: result.row.decidedBy,
        decidedAt: result.row.decidedAt?.toISOString() ?? null,
      });
    }

    if (result.conflict && result.current) {
      return reviewDecisionConflictResponse(result.current);
    }

    return NextResponse.json(
      { ok: false, error: "Database unavailable" },
      { status: 503 }
    );
  } catch (error) {
    console.error("[review/edit] Unexpected error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
