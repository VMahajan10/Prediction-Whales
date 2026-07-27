import {
  canMutateReviewItem,
  findQueueById,
  updateQueueById,
} from "@/lib/x-agent/reviewDb";
import { publishXPostQueueItem } from "@/lib/x-agent/publishQueuePost";
import { sanitizeXPostCopy } from "@/lib/x-agent/templates";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type ReviewEditAction = "approve" | "reject";

interface ReviewEditBody {
  id?: string;
  updatedText?: string;
  action?: string;
}

function parseAction(value: string | undefined): ReviewEditAction | null {
  if (value === "approve" || value === "reject") return value;
  return null;
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

  if (!id || !action) {
    return NextResponse.json(
      { ok: false, error: "id and action=approve|reject are required" },
      { status: 400 }
    );
  }

  const item = await findQueueById(id);
  if (!item) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  if (!canMutateReviewItem(item)) {
    return NextResponse.json(
      { ok: false, error: `Queue item is already ${item.status}` },
      { status: 409 }
    );
  }

  if (action === "reject") {
    const updated = await updateQueueById(id, { status: "KILLED" });
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "Database unavailable" },
        { status: 503 }
      );
    }

    return NextResponse.json({
      ok: true,
      status: updated.status,
      tradeId: updated.tradeId,
    });
  }

  const copyText = sanitizeXPostCopy(updatedText);
  if (!copyText) {
    return NextResponse.json(
      { ok: false, error: "Post copy is empty after safety sanitization" },
      { status: 400 }
    );
  }

  const updated = await updateQueueById(id, {
    copyText,
    status: "APPROVED",
  });

  if (!updated) {
    return NextResponse.json(
      { ok: false, error: "Database unavailable" },
      { status: 503 }
    );
  }

  let publish: Awaited<ReturnType<typeof publishXPostQueueItem>> | undefined;
  try {
    publish = await publishXPostQueueItem(updated);
  } catch (error) {
    console.error("[review/edit] publish failed:", error);
    publish = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return NextResponse.json({
    ok: true,
    status: publish?.ok ? "DISPATCHED" : updated.status,
    tradeId: updated.tradeId,
    copyText: updated.copyText,
    publish: publish ?? { ok: false, error: "Publish did not run" },
  });
}
