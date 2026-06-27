"use client";

import { useDemoAuth } from "@/lib/DemoAuthGateContext";

export default function DemoLogoutButton() {
  const { logout } = useDemoAuth();

  return (
    <button
      type="button"
      onClick={logout}
      className="rounded-full border border-pulse-border bg-pulse-card px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-pulse-muted transition-colors hover:border-pulse-accent hover:text-pulse-accent"
      title="Clear demo session and show signup screen again"
    >
      Log out
    </button>
  );
}
