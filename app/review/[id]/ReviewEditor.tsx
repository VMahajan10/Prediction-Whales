"use client";

import { useMemo, useState } from "react";
import {
  formatReviewEvLabel,
  formatReviewStakeUsd,
  humanizeMarketSlug,
} from "@/lib/reviewDisplay";

const MAX_POST_CHARS = 280;

export interface ReviewEditorProps {
  queueId: string;
  marketName: string;
  stakeLabel: string;
  evLabel: string;
  whaleName: string;
  generatedPostText: string;
  status: string;
}

export { formatReviewStakeUsd as formatStakeUsd, humanizeMarketSlug } from "@/lib/reviewDisplay";

export default function ReviewEditor({
  queueId,
  marketName,
  stakeLabel,
  evLabel,
  whaleName,
  generatedPostText,
  status,
}: ReviewEditorProps) {
  const [text, setText] = useState(generatedPostText);
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(
    null
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const charCount = text.length;
  const overLimit = charCount > MAX_POST_CHARS;
  const canEdit = status === "PENDING_REVIEW" || status === "EDITED";

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

    try {
      const res = await fetch("/api/x-agent/review/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: queueId,
          updatedText: text,
          action,
        }),
      });

      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        status?: string;
        publish?: { ok?: boolean; error?: string; tweetId?: string };
      };

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Request failed");
        return;
      }

      if (action === "reject") {
        setMessage("Draft rejected. It will not be published.");
        return;
      }

      if (data.publish?.ok) {
        setMessage(
          data.publish.tweetId
            ? `Approved and posted to X (tweet ${data.publish.tweetId}).`
            : "Approved and posted to X."
        );
        return;
      }

      setMessage(
        data.publish?.error
          ? `Approved, but posting failed: ${data.publish.error}`
          : "Approved. Posting will be retried."
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
            {submitting === "approve" ? "Posting…" : "Approve & Post"}
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
