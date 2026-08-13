"use client";

import Link from "next/link";
import { FINANCIAL_DISCLAIMER_SUMMARY } from "@/lib/legalCompliance";

interface FinancialDisclaimerModalProps {
  onAccept: () => void;
}

export default function FinancialDisclaimerModal({
  onAccept,
}: FinancialDisclaimerModalProps) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/80 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="financial-disclaimer-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-pulse-border bg-pulse-card p-6 shadow-2xl">
        <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-accent">
          Important notice
        </p>
        <h2
          id="financial-disclaimer-title"
          className="mt-2 text-lg font-bold text-white"
        >
          Financial disclaimer
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-pulse-muted">
          {FINANCIAL_DISCLAIMER_SUMMARY}
        </p>
        <p className="mt-4 text-xs leading-relaxed text-pulse-label">
          By continuing, you also agree to our{" "}
          <Link href="/terms" className="text-pulse-accent hover:underline">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="text-pulse-accent hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
        <button
          type="button"
          onClick={onAccept}
          className="mt-6 w-full rounded-xl bg-pulse-accent px-4 py-3 text-sm font-bold text-black transition-opacity hover:opacity-90"
        >
          I Understand &amp; Accept
        </button>
      </div>
    </div>
  );
}
