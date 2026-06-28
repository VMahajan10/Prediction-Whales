"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import MobileAppShell from "@/components/MobileAppShell";
import TraderAlertSync from "@/components/TraderAlertSync";
import { LiveFeedPlatformProvider } from "@/lib/LiveFeedPlatformContext";
import type { TraderAlert } from "@/lib/traderAlerts";
import { useTraderAlertsStore } from "@/lib/useTraderAlertsStore";

type AlertTab = "all" | "unread";

function secondsAgo(detectedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - detectedAt) / 1000));
}

function traderInitials(label: string, wallet: string): string {
  const fromLabel = label.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
  if (fromLabel.length >= 2) return fromLabel;
  return wallet.slice(2, 4).toUpperCase();
}

function isToday(timestamp: number): boolean {
  const date = new Date(timestamp);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function AlertRow({
  alert,
  now,
  onRead,
}: {
  alert: TraderAlert;
  now: number;
  onRead: (id: string) => void;
}) {
  const isBuy = alert.side === "BUY";
  const href =
    alert.source === "kalshi"
      ? `/trades/kalshi/${encodeURIComponent(alert.id.replace(/^kalshi:/, ""))}`
      : alert.txHash
        ? `/whales/${encodeURIComponent(alert.txHash)}`
        : `/traders/${encodeURIComponent(alert.wallet)}`;

  return (
    <li>
      <Link
        href={href}
        onClick={() => {
          if (!alert.read) onRead(alert.id);
        }}
        className={`block rounded-pulse border px-4 py-3 transition-colors ${
          alert.read
            ? "border-pulse-border bg-pulse-card/60"
            : "border-pulse-accent/30 bg-pulse-card"
        }`}
      >
        <div className="flex items-start gap-3">
          {!alert.read && (
            <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-pulse-accent" />
          )}
          {alert.read && <span className="mt-2 h-2 w-2 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-[10px] font-bold text-pulse-accent">
                {traderInitials(alert.traderLabel, alert.wallet)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-white">
                  {alert.traderLabel}
                </p>
              </div>
              <span className="text-[11px] text-pulse-label">
                {secondsAgo(alert.detectedAt, now)}s
              </span>
            </div>

            <p className="mt-2 text-sm font-medium leading-snug text-white">
              {alert.title}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  isBuy
                    ? "bg-pulse-yes/15 text-pulse-yes"
                    : "bg-pulse-no/15 text-pulse-no"
                }`}
              >
                {isBuy ? `Backing ${alert.outcome}` : `Exit ${alert.outcome}`}
              </span>
              <span
                className={`text-[11px] font-bold uppercase ${
                  isBuy ? "text-pulse-yes" : "text-pulse-no"
                }`}
              >
                {isBuy ? "↗ Buy" : "↘ Sell"}
              </span>
              <span className="text-[11px] font-semibold text-pulse-muted">
                {(alert.price * 100).toFixed(0)}¢ entry
              </span>
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

function AlertSection({
  title,
  alerts,
  now,
  onRead,
}: {
  title: string;
  alerts: TraderAlert[];
  now: number;
  onRead: (id: string) => void;
}) {
  if (alerts.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="pulse-label mb-3 text-pulse-label">{title}</h2>
      <ul className="space-y-2">
        {alerts.map((alert) => (
          <AlertRow
            key={alert.id}
            alert={alert}
            now={now}
            onRead={onRead}
          />
        ))}
      </ul>
    </section>
  );
}

function AlertsContent() {
  const { alerts, unreadCount, markRead, markAllRead } = useTraderAlertsStore();
  const [tab, setTab] = useState<AlertTab>("all");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const visible = useMemo(() => {
    const rows = tab === "unread" ? alerts.filter((a) => !a.read) : alerts;
    return rows;
  }, [alerts, tab]);

  const todayAlerts = visible.filter((a) => isToday(a.detectedAt));
  const earlierAlerts = visible.filter((a) => !isToday(a.detectedAt));

  return (
    <main className="min-h-screen px-4 py-5">
      <header className="mb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-white">Alerts</h1>
          {unreadCount > 0 && (
            <span className="rounded-full bg-pulse-accent px-2 py-0.5 text-[10px] font-bold uppercase text-white">
              {unreadCount} new
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="mt-2 text-sm font-semibold text-pulse-accent"
          >
            Mark all read
          </button>
        )}
      </header>

      <div className="mb-5 mt-4 flex rounded-pulse border border-pulse-border bg-pulse-surface p-1">
        <button
          type="button"
          onClick={() => setTab("all")}
          className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
            tab === "all"
              ? "bg-pulse-accent text-white"
              : "text-pulse-muted hover:text-white"
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setTab("unread")}
          className={`relative flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
            tab === "unread"
              ? "bg-pulse-accent text-white"
              : "text-pulse-muted hover:text-white"
          }`}
        >
          Unread
          {unreadCount > 0 && tab !== "unread" && (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-pulse-accent px-1 text-[10px] text-white">
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="pulse-card px-6 py-12 text-center">
          <p className="text-3xl">🔔</p>
          <p className="mt-3 text-sm text-pulse-muted">
            {tab === "unread"
              ? "You're all caught up"
              : "No alerts yet from your watchlist"}
          </p>
          <p className="mt-2 text-xs text-pulse-label">
            Whale trades from starred traders show up here in real time
          </p>
          <Link
            href="/following"
            className="mt-5 inline-block text-sm font-semibold text-pulse-accent"
          >
            Manage watchlist →
          </Link>
        </div>
      ) : (
        <>
          <AlertSection
            title="Today"
            alerts={todayAlerts}
            now={now}
            onRead={markRead}
          />
          <AlertSection
            title="Earlier"
            alerts={earlierAlerts}
            now={now}
            onRead={markRead}
          />
        </>
      )}
    </main>
  );
}

export default function AlertsPage() {
  return (
    <LiveFeedPlatformProvider>
      <MobileAppShell>
        <TraderAlertSync />
        <AlertsContent />
      </MobileAppShell>
    </LiveFeedPlatformProvider>
  );
}
