import {
  canMutateReviewItem,
  findQueueByReviewToken,
  updateQueueByReviewToken,
} from "@/lib/x-agent/reviewDb";
import { sanitizeXPostCopy } from "@/lib/x-agent/templates";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseToken(request: NextRequest): string | null {
  const fromQuery = request.nextUrl.searchParams.get("token");
  return fromQuery?.trim() ? fromQuery.trim() : null;
}

function renderEditForm(params: {
  token: string;
  copyText: string;
  marketSlug: string;
  templateFamily: string;
  error?: string;
  saved?: boolean;
}): string {
  const errorBlock = params.error
    ? `<p class="err">${escapeHtml(params.error)}</p>`
    : "";
  const savedBlock = params.saved
    ? `<p class="ok">Draft saved. Status set to EDITED.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Edit X Draft</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 20px; background: #0b1220; color: #e8eef8; }
    main { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    .meta { color: #94a3b8; font-size: 0.9rem; margin-bottom: 16px; }
    textarea { width: 100%; min-height: 180px; box-sizing: border-box; border-radius: 12px; border: 1px solid #334155; background: #111827; color: #f8fafc; padding: 14px; font-size: 1rem; line-height: 1.45; resize: vertical; }
    button { margin-top: 14px; width: 100%; border: 0; border-radius: 12px; padding: 14px 16px; font-size: 1rem; font-weight: 600; background: #2563eb; color: white; }
    .ok { color: #86efac; }
    .err { color: #fca5a5; }
    .hint { color: #94a3b8; font-size: 0.85rem; margin-top: 10px; }
  </style>
</head>
<body>
  <main>
    <h1>Edit X draft</h1>
    <p class="meta">${escapeHtml(params.marketSlug)} · ${escapeHtml(params.templateFamily)}</p>
    ${savedBlock}
    ${errorBlock}
    <form method="POST">
      <input type="hidden" name="token" value="${escapeHtml(params.token)}" />
      <label for="copyText">Post copy</label>
      <textarea id="copyText" name="copyText" maxlength="280" required>${escapeHtml(params.copyText)}</textarea>
      <p class="hint">URLs, siren emojis, and extra hashtags are stripped on save.</p>
      <button type="submit">Save draft</button>
    </form>
  </main>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const token = parseToken(request);
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const item = await findQueueByReviewToken(token);
  if (!item) {
    return new NextResponse(
      renderEditForm({
        token,
        copyText: "",
        marketSlug: "Unknown",
        templateFamily: "—",
        error: "Review link is invalid or expired.",
      }),
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  if (!canMutateReviewItem(item) && item.status !== "APPROVED") {
    return new NextResponse(
      renderEditForm({
        token,
        copyText: item.copyText,
        marketSlug: item.marketSlug,
        templateFamily: item.templateFamily,
        error: `This draft is ${item.status} and can no longer be edited.`,
      }),
      { status: 409, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const saved = request.nextUrl.searchParams.get("saved") === "1";

  return new NextResponse(
    renderEditForm({
      token,
      copyText: item.copyText,
      marketSlug: item.marketSlug,
      templateFamily: item.templateFamily,
      saved,
    }),
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const tokenField = form.get("token");
  const token =
    typeof tokenField === "string" && tokenField.trim()
      ? tokenField.trim()
      : parseToken(request);

  if (!token || typeof token !== "string" || !token.trim()) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const rawCopy = form.get("copyText");
  if (typeof rawCopy !== "string" || !rawCopy.trim()) {
    return new NextResponse(
      renderEditForm({
        token: token.trim(),
        copyText: "",
        marketSlug: "Unknown",
        templateFamily: "—",
        error: "Post copy cannot be empty.",
      }),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const item = await findQueueByReviewToken(token.trim());
  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!canMutateReviewItem(item)) {
    return new NextResponse(
      renderEditForm({
        token: token.trim(),
        copyText: item.copyText,
        marketSlug: item.marketSlug,
        templateFamily: item.templateFamily,
        error: `This draft is ${item.status} and can no longer be edited.`,
      }),
      { status: 409, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const copyText = sanitizeXPostCopy(rawCopy);
  if (!copyText) {
    return new NextResponse(
      renderEditForm({
        token: token.trim(),
        copyText: rawCopy,
        marketSlug: item.marketSlug,
        templateFamily: item.templateFamily,
        error: "Post copy is empty after safety sanitization.",
      }),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const updated = await updateQueueByReviewToken(token.trim(), {
    copyText,
    status: "EDITED",
  });

  if (!updated) {
    return NextResponse.json(
      { ok: false, error: "Database unavailable" },
      { status: 503 }
    );
  }

  const redirectUrl = new URL(request.url);
  redirectUrl.searchParams.set("token", token.trim());
  redirectUrl.searchParams.set("saved", "1");

  return NextResponse.redirect(redirectUrl, 303);
}
