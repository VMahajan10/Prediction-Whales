"use client";

import { useEffect, useMemo, useState } from "react";
import { buildScheduleApprovalUiMessage, formatScheduledClockTime } from "@/lib/x-agent/scheduleMessages";
import { isDraftQueueStatus } from "@/lib/x-agent/postStatus";
import { formatReviewDecisionBadge } from "@/lib/x-agent/reviewDecision";
import {
  formatReviewStakeUsd,
  humanizeMarketSlug,
} from "@/lib/reviewDisplay";

const MAX_POST_CHARS = 280;
const DECIDER_STORAGE_KEY = "marketpulse.reviewDeciderName";

type ScheduleMode = "default" | "immediate" | "custom";

export interface ReviewEditorProps {
  queueId: string;
  marketName: string;
  stakeLabel: string;
  evLabel: string;
  whaleName: string;
  generatedPostText: string;
  status: string;
  defaultScheduledAtIso: string;
  decisionBadge: string | null;
  decidedBy: string | null;
  decidedAtIso: string | null;
}

export { formatReviewStakeUsd as formatStakeUsd, humanizeMarketSlug } from "@/lib/reviewDisplay";

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export default function ReviewEditor({
  queueId,
  marketName,
  stakeLabel,
  evLabel,
  whaleName,
  generatedPostText,
  status: initialStatus,
  defaultScheduledAtIso,
  decisionBadge: initialDecisionBadge,
  decidedBy: initialDecidedBy,
  decidedAtIso: initialDecidedAtIso,
}: ReviewEditorProps) {
  const [text, setText] = useState(generatedPostText);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("default");
  const [customScheduledAt, setCustomScheduledAt] = useState(
    toDatetimeLocalValue(defaultScheduledAtIso)
  );
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(
    null
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [itemStatus, setItemStatus] = useState(initialStatus);
  const [decisionBadge, setDecisionBadge] = useState(initialDecisionBadge);
  const [deciderName, setDeciderName] = useState("");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DECIDER_STORAGE_KEY);
      if (stored?.trim()) setDeciderName(stored.trim());
    } catch {
      // Ignore localStorage errors (private mode, etc.).
    }
  }, []);

  const charCount = text.length;
  const overLimit = charCount > MAX_POST_CHARS;
  const canEdit = isDraftQueueStatus(itemStatus);

  const defaultScheduledLabel = formatScheduledClockTime(defaultScheduledAtIso);

  const counterClass = useMemo(() => {
    if (overLimit) return "text-red-400";
    if (charCount > MAX_POST_CHARS - 20) return "text-amber-400";
    return "text-pulse-label";
  }, [charCount, overLimit]);

  function persistDeciderName(value: string) {
    setDeciderName(value);
    try {
      if (value.trim()) {
        window.localStorage.setItem(DECIDER_STORAGE_KEY, value.trim());
      } else {
        window.localStorage.removeItem(DECIDER_STORAGE_KEY);
      }
    } catch {
      // Ignore localStorage errors.
    }
  }

  function applyFinalizedState(
    status: string,
    decidedBy: string | null,
    decidedAtIso: string | null
  ) {
    setItemStatus(status);
    setDecisionBadge(
      formatReviewDecisionBadge(status, decidedBy, decidedAtIso)
    );
  }

  function handleConflictResponse(data: {
    error?: string;
    status?: string;
    decidedBy?: string | null;
    decidedAt?: string | null;
  }) {
    const conflictMessage =
      data.error ?? "This trade decision has already been finalized.";
    setError(conflictMessage);
    if (data.status) {
      applyFinalizedState(
        data.status,
        data.decidedBy ?? null,
        data.decidedAt ?? null
      );
    }
  }

  async function submitAction(action: "approve" | "reject") {
    if (!canEdit || submitting) return;
    if (action === "approve" && (overLimit || !text.trim())) return;

    setSubmitting(action);
    setError(null);
    setMessage(null);

    const customIso =
      scheduleMode === "custom"
        ? fromDatetimeLocalValue(customScheduledAt)
        : null;

    if (action === "approve" && scheduleMode === "custom" && !customIso) {
      setError("Pick a valid custom schedule time.");
      setSubmitting(null);
      return;
    }

    try {
      const res = await fetch("/api/x-agent/review/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: queueId,
          updatedText: text,
          action,
          scheduleMode,
          decidedBy: deciderName.trim() || undefined,
          ...(customIso ? { scheduledAt: customIso } : {}),
        }),
      });

      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        conflict?: boolean;
        status?: string;
        decidedBy?: string | null;
        decidedAt?: string | null;
        scheduledAt?: string;
        message?: string;
        scheduledTimeLabel?: string;
      };

      if (res.status === 409 || data.conflict) {
        handleConflictResponse(data);
        return;
      }

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Request failed");
        return;
      }

      if (data.status) {
        applyFinalizedState(
          data.status,
          data.decidedBy ?? (deciderName.trim() || null),
          data.decidedAt ?? null
        );
      }

      if (action === "reject") {
        setMessage("Draft rejected. It will not be published.");
        return;
      }

      setMessage(
        data.message ??
          (data.scheduledAt
            ? buildScheduleApprovalUiMessage(data.scheduledAt)
            : data.scheduledTimeLabel
              ? `Approved! Scheduled for X at ${data.scheduledTimeLabel}.`
              : "Approved! Scheduled for X.")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-8">
      <div className="mb-6">
        <p className="pulse-label mb-2">X Post Review</p>
        <h1 className="text-2xl font-bold text-white">Edit queued post</h1>
        {decisionBadge && (
          <p className="mt-3 rounded-pulse border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200">
            {decisionBadge}
          </p>
        )}
        {!canEdit && !decisionBadge && (
          <p className="mt-2 text-sm text-amber-400">
            This draft is {itemStatus.toLowerCase().replace(/_/g, " ")} and can
            no longer be edited.
          </p>
        )}
      </div>

      {canEdit && (
        <section className="pulse-card mb-6 p-4">
          <label htmlFor="decider-name" className="pulse-label mb-2 block">
            Your name (for audit trail)
          </label>
          <input
            id="decider-name"
            type="text"
            value={deciderName}
            onChange={(event) => persistDeciderName(event.target.value)}
            disabled={submitting != null}
            placeholder="e.g. Vaibhav"
            className="w-full rounded-pulse border border-pulse-border bg-black px-3 py-2 text-sm text-white outline-none focus:border-pulse-accent"
          />
        </section>
      )}

      <section className="pulse-card mb-6 space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="pulse-label">Market</p>
            <p className="text-sm font-semibold text-white">{marketName}</p>
          </div>
          <div>
            <p className="pulse-label">Whale</p>
            <p className="text-sm font-semibold text-white">{whaleName}</p>
          </div>
          <div>
            <p className="pulse-label">Stake</p>
            <p className="text-sm font-semibold text-white">{stakeLabel}</p>
          </div>
          <div>
            <p className="pulse-label">EV</p>
            <p className="text-sm font-semibold text-white">{evLabel}</p>
          </div>
        </div>
      </section>

      <section className="pulse-card p-5">
        <label htmlFor="post-copy" className="pulse-label mb-2 block">
          Post copy
        </label>
        <textarea
          id="post-copy"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={!canEdit || submitting != null}
          maxLength={MAX_POST_CHARS + 40}
          rows={8}
          className="w-full resize-y rounded-pulse border border-pulse-border bg-black px-4 py-3 text-base leading-relaxed text-white outline-none transition-colors focus:border-pulse-accent focus:ring-1 focus:ring-pulse-accent/40 disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-pulse-label">
            URLs, siren emojis, and extra hashtags are stripped on save.
          </p>
          <p className={`text-xs font-semibold ${counterClass}`}>
            {charCount}/{MAX_POST_CHARS}
          </p>
        </div>

        {canEdit && (
          <div className="mt-6 space-y-3">
            <p className="pulse-label">Schedule publish</p>
            <div className="space-y-2">
              <label className="flex items-start gap-3 text-sm text-pulse-muted">
                <input
                  type="radio"
                  name="schedule-mode"
                  checked={scheduleMode === "default"}
                  onChange={() => setScheduleMode("default")}
                  disabled={submitting != null}
                  className="mt-1"
                />
                <span>
                  Default window (15–120 min){" "}
                  <span className="text-white">(~{defaultScheduledLabel})</span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm text-pulse-muted">
                <input
                  type="radio"
                  name="schedule-mode"
                  checked={scheduleMode === "immediate"}
                  onChange={() => setScheduleMode("immediate")}
                  disabled={submitting != null}
                  className="mt-1"
                />
                <span>Post as soon as possible (next cron tick, ~1 min)</span>
              </label>
              <label className="flex items-start gap-3 text-sm text-pulse-muted">
                <input
                  type="radio"
                  name="schedule-mode"
                  checked={scheduleMode === "custom"}
                  onChange={() => setScheduleMode("custom")}
                  disabled={submitting != null}
                  className="mt-1"
                />
                <span className="flex-1">
                  Custom time
                  {scheduleMode === "custom" && (
                    <input
                      type="datetime-local"
                      value={customScheduledAt}
                      onChange={(e) => setCustomScheduledAt(e.target.value)}
                      disabled={submitting != null}
                      className="mt-2 w-full rounded-pulse border border-pulse-border bg-black px-3 py-2 text-sm text-white outline-none focus:border-pulse-accent"
                    />
                  )}
                </span>
              </label>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-pulse border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        {message && (
          <p className="mt-4 rounded-pulse border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            {message}
          </p>
        )}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void submitAction("approve")}
            disabled={!canEdit || submitting != null || overLimit || !text.trim()}
            className="pulse-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting === "approve" ? "SCHEDULING…" : "APPROVE & SCHEDULE"}
          </button>
          <button
            type="button"
            onClick={() => void submitAction("reject")}
            disabled={!canEdit || submitting != null}
            className="w-full rounded-pulse border border-red-500/50 bg-red-500/10 py-3.5 text-sm font-bold uppercase tracking-wide text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </section>
    </main>
  );
}
