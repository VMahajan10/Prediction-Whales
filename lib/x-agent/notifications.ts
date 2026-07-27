import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import { buildReviewEditLoginUrl } from "@/lib/authRedirect";
import { getAppBaseUrl } from "@/lib/appBaseUrl";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { formatToEST } from "@/lib/client-utils";

export interface ReviewActionLinks {
  approve: string;
  kill: string;
  edit: string;
}

export interface AdminReviewAlertPayload {
  type: "x_agent_review";
  queueId: string;
  tradeId: string;
  walletAddress: string;
  templateFamily: string;
  marketSlug: string;
  side: string;
  stakeNotional: number;
  copyText: string;
  links: ReviewActionLinks;
  message: string;
}

export interface AdminChannelResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export interface AdminReviewAlertResult {
  webhook: AdminChannelResult;
  sms: AdminChannelResult;
  email: AdminChannelResult;
}

/** Build 1-tap admin review URLs for a queued X post. */
export function buildReviewActionLinks(
  reviewToken: string,
  baseUrl?: string,
  queueId?: string
): ReviewActionLinks {
  const base = (baseUrl ?? getAppBaseUrl()).replace(/\/$/, "");
  const token = encodeURIComponent(reviewToken);

  return {
    approve: `${base}/api/x-agent/review/action?token=${token}&action=approve`,
    kill: `${base}/api/x-agent/review/action?token=${token}&action=kill`,
    edit: queueId
      ? buildReviewEditLoginUrl(queueId)
      : `${base}/api/x-agent/review/edit?token=${token}`,
  };
}

function buildAlertPayload(
  queueItem: XPostQueue,
  links: ReviewActionLinks
): AdminReviewAlertPayload {
  const message = [
    "X Agent draft ready for review",
    `Trade: ${queueItem.tradeId}`,
    `Queued: ${formatToEST(queueItem.createdAt)}`,
    `Market: ${queueItem.marketSlug}`,
    `Template: ${queueItem.templateFamily}`,
    "",
    queueItem.copyText,
    "",
    `Approve: ${links.approve}`,
    `Edit: ${links.edit}`,
    `Kill: ${links.kill}`,
  ].join("\n");

  return {
    type: "x_agent_review",
    queueId: queueItem.id,
    tradeId: queueItem.tradeId,
    walletAddress: queueItem.walletAddress,
    templateFamily: queueItem.templateFamily,
    marketSlug: queueItem.marketSlug,
    side: queueItem.side,
    stakeNotional: queueItem.stakeNotional,
    copyText: queueItem.copyText,
    links,
    message,
  };
}

async function postAdminEndpoint(
  url: string | undefined,
  payload: AdminReviewAlertPayload,
  label: string
): Promise<AdminChannelResult> {
  if (!url?.trim()) {
    return { ok: false, skipped: true, error: `${label} endpoint not configured` };
  }

  try {
    const res = await fetchWithTimeout(url.trim(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(process.env.X_AGENT_ADMIN_NOTIFY_SECRET
          ? {
              Authorization: `Bearer ${process.env.X_AGENT_ADMIN_NOTIFY_SECRET}`,
            }
          : {}),
      },
      body: JSON.stringify(payload),
      timeoutMs: 12_000,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `${label} HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Notify all configured admin channels (webhook, SMS, email) that a draft
 * X post is ready for human review.
 */
export async function dispatchAdminReviewAlert(
  queueItem: XPostQueue
): Promise<AdminReviewAlertResult> {
  const links = buildReviewActionLinks(
    queueItem.reviewToken,
    undefined,
    queueItem.id
  );
  const payload = buildAlertPayload(queueItem, links);

  const [webhook, sms, email] = await Promise.all([
    postAdminEndpoint(
      process.env.X_AGENT_ADMIN_WEBHOOK_URL,
      payload,
      "webhook"
    ),
    postAdminEndpoint(process.env.X_AGENT_ADMIN_SMS_URL, payload, "sms"),
    postAdminEndpoint(process.env.X_AGENT_ADMIN_EMAIL_URL, payload, "email"),
  ]);

  return { webhook, sms, email };
}
