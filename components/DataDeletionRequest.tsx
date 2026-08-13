"use client";

import { useState } from "react";
import {
  buildDataDeletionMailto,
  clearAllLocalUserData,
  DATA_DELETION_EMAIL,
} from "@/lib/legalCompliance";
import { clearDemoEntered } from "@/lib/demoAuthGate";

export default function DataDeletionRequest() {
  const [cleared, setCleared] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleRequestDeletion() {
    setError(null);
    try {
      clearAllLocalUserData();
      clearDemoEntered();
      setCleared(true);
      window.location.href = buildDataDeletionMailto();
    } catch {
      setError(
        "Could not clear all on-device data automatically. Please email us directly."
      );
      window.location.href = buildDataDeletionMailto();
    }
  }

  return (
    <div className="rounded-2xl border border-pulse-border bg-pulse-card p-5">
      <h2 className="text-base font-bold text-white">
        Request account / data deletion
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-pulse-muted">
        You can remove on-device preferences stored in this browser or app, and
        email us to delete any server-side data associated with your account or
        contact information.
      </p>
      <button
        type="button"
        onClick={handleRequestDeletion}
        className="mt-4 inline-flex w-full items-center justify-center rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200 transition-colors hover:bg-red-500/15 sm:w-auto"
      >
        Request Account / Data Deletion
      </button>
      {cleared ? (
        <p className="mt-3 text-xs text-pulse-yes">
          On-device preferences cleared. Complete the email to finish your
          request.
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-xs text-red-300">{error}</p>
      ) : null}
      <p className="mt-3 text-xs text-pulse-label">
        Or email{" "}
        <a
          href={`mailto:${DATA_DELETION_EMAIL}`}
          className="font-semibold text-pulse-accent hover:underline"
        >
          {DATA_DELETION_EMAIL}
        </a>{" "}
        with the subject &quot;Data Deletion Request&quot;.
      </p>
    </div>
  );
}
