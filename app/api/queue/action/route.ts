import {
  computeApprovalScheduledFor,
  finalizeQueueByIdIfPending,
  findQueueById,
} from "@/lib/x-agent/reviewDb";
import { POST_STATUS } from "@/lib/x-agent/postStatus";
import { formatToEST } from "@/lib/client-utils";
import { normalizeDecidedBy } from "@/lib/x-agent/reviewDecision";
import {
  reviewDecisionConflictHtml,
  reviewDecisionConflictResponse,
} from "@/lib/x-agent/reviewApiHelpers";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type QueueAction = "approve" | "reject";

function parseAction(value: string | null): QueueAction | null {
  if (value === "approve" || value === "reject") return value;
  return null;
}

function wantsHtml(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

function htmlResponse(title: string, body: string, status = 200): NextResponse {
  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #0b1220; color: #e8eef8; }
    main { max-width: 520px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { line-height: 1.5; color: #b8c4d9; }
    .ok { color: #86efac; }
    .err { color: #fca5a5; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`;

  return new NextResponse(page, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleQueueAction(
  request: NextRequest,
  queueId: string,
  action: QueueAction,
  decidedByInput?: string
): Promise<NextResponse> {
  const decidedBy = normalizeDecidedBy(decidedByInput ?? "Email link");

  const item = await findQueueById(queueId);
  if (!item) {
    if (wantsHtml(request)) {
      return htmlResponse("Not found", "Review link is invalid or expired.", 404);
    }
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  if (action === "reject") {
    const result = await finalizeQueueByIdIfPending(queueId, {
      status: "KILLED",
      decidedBy,
    });

    if (result.ok) {
      if (wantsHtml(request)) {
        return htmlResponse(
          "Draft rejected",
          `<span class="err">This X post draft was rejected and will not be published.</span>`
        );
      }

      return NextResponse.json({
        ok: true,
        status: result.row.status,
        tradeId: result.row.tradeId,
        decidedBy: result.row.decidedBy,
        decidedAt: result.row.decidedAt?.toISOString() ?? null,
      });
    }

    if (result.conflict && result.current) {
      if (wantsHtml(request)) {
        return htmlResponse(
          "Unavailable",
          `<span class="err">${reviewDecisionConflictHtml(result.current)}</span>`,
          409
        );
      }
      return reviewDecisionConflictResponse(result.current);
    }

    return NextResponse.json(
      { ok: false, error: "Database unavailable" },
      { status: 503 }
    );
  }

  const scheduledFor = computeApprovalScheduledFor();
  const result = await finalizeQueueByIdIfPending(queueId, {
    status: POST_STATUS.SCHEDULED,
    scheduledFor,
    decidedBy,
  });

  if (result.ok) {
    const scheduledLabel = formatToEST(scheduledFor);

    if (wantsHtml(request)) {
      return htmlResponse(
        "Draft approved",
        `<span class="ok">Approved.</span> Scheduled with jitter for <strong>${scheduledLabel}</strong>.`
      );
    }

    return NextResponse.json({
      ok: true,
      status: result.row.status,
      scheduledFor:
        result.row.scheduledFor?.toISOString() ?? scheduledFor.toISOString(),
      tradeId: result.row.tradeId,
      decidedBy: result.row.decidedBy,
      decidedAt: result.row.decidedAt?.toISOString() ?? null,
    });
  }

  if (result.conflict && result.current) {
    if (wantsHtml(request)) {
      return htmlResponse(
        "Unavailable",
        `<span class="err">${reviewDecisionConflictHtml(result.current)}</span>`,
        409
      );
    }
    return reviewDecisionConflictResponse(result.current);
  }

  return NextResponse.json(
    { ok: false, error: "Database unavailable" },
    { status: 503 }
  );
}

export async function GET(request: NextRequest) {
  const queueId = request.nextUrl.searchParams.get("id")?.trim();
  const action = parseAction(request.nextUrl.searchParams.get("action"));
  const decidedBy = request.nextUrl.searchParams.get("decidedBy") ?? undefined;

  if (!queueId || !action) {
    return NextResponse.json(
      { error: "id and action=approve|reject are required" },
      { status: 400 }
    );
  }

  return handleQueueAction(request, queueId, action, decidedBy);
}

export async function POST(request: NextRequest) {
  let queueId = request.nextUrl.searchParams.get("id")?.trim();
  let action = parseAction(request.nextUrl.searchParams.get("action"));
  let decidedBy: string | undefined;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as {
        id?: string;
        action?: string;
        decidedBy?: string;
      };
      queueId = body.id?.trim() ?? queueId;
      action = parseAction(body.action ?? null) ?? action;
      decidedBy = body.decidedBy ?? undefined;
    } catch {
      // Fall back to query params.
    }
  }

  if (!queueId || !action) {
    return NextResponse.json(
      { error: "id and action=approve|reject are required" },
      { status: 400 }
    );
  }

  return handleQueueAction(request, queueId, action, decidedBy);
}
