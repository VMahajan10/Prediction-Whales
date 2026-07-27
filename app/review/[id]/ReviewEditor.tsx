"use client";

import { useMemo, useState } from "react";
import { buildScheduleApprovalUiMessage, formatScheduledClockTime } from "@/lib/x-agent/scheduleMessages";
import { isDraftQueueStatus } from "@/lib/x-agent/postStatus";
import {
  formatReviewStakeUsd,
  humanizeMarketSlug,
} from "@/lib/reviewDisplay";

const MAX_POST_CHARS = 280;

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
  status,
  defaultScheduledAtIso,
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

  const charCount = text.length;
  const overLimit = charCount > MAX_POST_CHARS;
  const canEdit = isDraftQueueStatus(status);

  const defaultScheduledLabel = formatScheduledClockTime(defaultScheduledAtIso);

  const counterClass = useMemo(() => {
    if (overLimit) return "text-red-400";
    if (charCount > MAX_POST_CHARS - 20) return "text-amber-400";
    return "text-pulse-label";
  }, [charCount, overLimit]);

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
          ...(customIso ? { scheduledAt: customIso } : {}),
        }),
      });

      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        scheduledAt?: string;
        message?: string;
        scheduledTimeLabel?: string;
      };

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Request failed");
        return;
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
        {!canEdit && (
          <p className="mt-2 text-sm text-amber-400">
            This draft is {status.toLowerCase().replace(/_/g, " ")} and can no
            longer be edited.
          </p>
        )}
      </div>

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
