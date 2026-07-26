import {
  canMutateReviewItem,
  computeApprovalScheduledFor,
  findQueueByReviewToken,
  updateQueueByReviewToken,
} from "@/lib/x-agent/reviewDb";
import { formatToEST } from "@/lib/client-utils";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type ReviewAction = "approve" | "kill";

function parseAction(value: string | null): ReviewAction | null {
  if (value === "approve" || value === "kill") return value;
  return null;
}

function parseToken(request: NextRequest): string | null {
  const fromQuery = request.nextUrl.searchParams.get("token");
  if (fromQuery?.trim()) return fromQuery.trim();
  return null;
}

async function parsePostPayload(
  request: NextRequest
): Promise<{ token: string | null; action: ReviewAction | null }> {
  const queryToken = parseToken(request);
  const queryAction = parseAction(request.nextUrl.searchParams.get("action"));

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { token?: string; action?: string };
      return {
        token: body.token?.trim() ?? queryToken,
        action: parseAction(body.action ?? null) ?? queryAction,
      };
    } catch {
      return { token: queryToken, action: queryAction };
    }
  }

  try {
    const form = await request.formData();
    const tokenField = form.get("token");
    const actionField = form.get("action");
    const token =
      typeof tokenField === "string" && tokenField.trim()
        ? tokenField.trim()
        : queryToken;
    const action =
      typeof actionField === "string"
        ? parseAction(actionField) ?? queryAction
        : queryAction;
    return { token, action };
  } catch {
    return { token: queryToken, action: queryAction };
  }
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

async function handleReviewAction(
  request: NextRequest,
  token: string,
  action: ReviewAction
): Promise<NextResponse> {
  const item = await findQueueByReviewToken(token);
  if (!item) {
    if (wantsHtml(request)) {
      return htmlResponse("Not found", "Review link is invalid or expired.", 404);
    }
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  if (!canMutateReviewItem(item)) {
    const message = `Queue item is already ${item.status}`;
    if (wantsHtml(request)) {
      return htmlResponse("Unavailable", message, 409);
    }
    return NextResponse.json({ ok: false, error: message }, { status: 409 });
  }

  if (action === "kill") {
    const updated = await updateQueueByReviewToken(token, { status: "KILLED" });
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "Database unavailable" },
        { status: 503 }
      );
    }

    if (wantsHtml(request)) {
      return htmlResponse(
        "Draft killed",
        `<span class="err">This X post draft was killed and will not be published.</span>`
      );
    }

    return NextResponse.json({
      ok: true,
      status: updated.status,
      tradeId: updated.tradeId,
    });
  }

  const scheduledFor = computeApprovalScheduledFor();
  const updated = await updateQueueByReviewToken(token, {
    status: "APPROVED",
    scheduledFor,
  });

  if (!updated) {
    return NextResponse.json(
      { ok: false, error: "Database unavailable" },
      { status: 503 }
    );
  }

  const scheduledLabel = formatToEST(scheduledFor);

  if (wantsHtml(request)) {
    return htmlResponse(
      "Draft approved",
      `<span class="ok">Approved.</span> Scheduled with jitter for <strong>${scheduledLabel}</strong>.`
    );
  }

  return NextResponse.json({
    ok: true,
    status: updated.status,
    scheduledFor: updated.scheduledFor?.toISOString() ?? scheduledFor.toISOString(),
    tradeId: updated.tradeId,
  });
}

export async function GET(request: NextRequest) {
  const token = parseToken(request);
  const action = parseAction(request.nextUrl.searchParams.get("action"));

  if (!token || !action) {
    return NextResponse.json(
      { error: "token and action=approve|kill are required" },
      { status: 400 }
    );
  }

  return handleReviewAction(request, token, action);
}

export async function POST(request: NextRequest) {
  const { token, action } = await parsePostPayload(request);

  if (!token || !action) {
    return NextResponse.json(
      { error: "token and action=approve|kill are required" },
      { status: 400 }
    );
  }

  return handleReviewAction(request, token, action);
}
