"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import FeedEmptyState from "@/components/FeedEmptyState";
import MobileAppShell from "@/components/MobileAppShell";
import TraderAlertSync from "@/components/TraderAlertSync";
import { LiveFeedPlatformProvider } from "@/lib/LiveFeedPlatformContext";
import type { TraderAlert } from "@/lib/traderAlerts";
import { useTraderAlertsStore } from "@/lib/useTraderAlertsStore";
import { useWhaleFeed } from "@/lib/useWhaleFeed";

type AlertTab = "all" | "unread";

function formatAlertRecency(detectedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - detectedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}hr`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
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

function backingLabel(alert: TraderAlert): string {
  if (alert.side === "SELL") {
    const name = alert.outcome?.trim();
    return name ? `Exit ${name}` : "Exit position";
  }
  const name = alert.outcome?.trim();
  return name ? `Backing ${name}` : "Backing position";
}

function alertDetailHref(alert: TraderAlert): string {
  if (alert.source === "kalshi") {
    return `/whales/kalshi/${encodeURIComponent(alert.id.replace(/^kalshi:/, ""))}`;
  }
  if (alert.txHash) {
    return `/whales/${encodeURIComponent(alert.txHash)}`;
  }
  return `/traders/${encodeURIComponent(alert.wallet)}`;
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
  const href = alertDetailHref(alert);
  const direction = backingLabel(alert);

  return (
    <li className="border-b border-pulse-border/80 last:border-0">
      <Link
        href={href}
        onClick={() => {
          if (!alert.read) onRead(alert.id);
        }}
        className="flex gap-3 py-4 transition-colors hover:bg-pulse-surface/20"
      >
        <div className="flex w-3 shrink-0 justify-center pt-4">
          {!alert.read ? (
            <span className="h-2 w-2 rounded-full bg-pulse-accent" />
          ) : (
            <span className="h-2 w-2" />
          )}
        </div>

        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-[10px] font-bold text-pulse-accent">
          {traderInitials(alert.traderLabel, alert.wallet)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-sm font-bold text-white">
              {alert.traderLabel}
            </p>
            <span className="shrink-0 text-[11px] text-pulse-label">
              {formatAlertRecency(alert.detectedAt, now)}
            </span>
          </div>

          <p className="mt-1 text-xs font-bold uppercase leading-snug tracking-wide text-white">
            {alert.title}
          </p>

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={`inline-block max-w-full truncate rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                  isBuy
                    ? "bg-pulse-yes/15 text-pulse-yes"
                    : "bg-pulse-no/15 text-pulse-no"
                }`}
              >
                {direction}
              </span>
              <span
                className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                  isBuy
                    ? "bg-pulse-yes/15 text-pulse-yes"
                    : "bg-pulse-no/15 text-pulse-no"
                }`}
              >
                <span aria-hidden>{isBuy ? "↗" : "↘"}</span>
                {isBuy ? "Buy" : "Sell"}
              </span>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-bold text-white">
                {(alert.price * 100).toFixed(0)}¢
              </p>
              <p className="text-[9px] font-bold uppercase tracking-wide text-pulse-label">
                Entry
              </p>
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
    <section className="mb-2">
      <h2 className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-pulse-label">
        {title}
      </h2>
      <ul>
        {alerts.map((alert) => (
          <AlertRow key={alert.id} alert={alert} now={now} onRead={onRead} />
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
    return tab === "unread" ? alerts.filter((a) => !a.read) : alerts;
  }, [alerts, tab]);

  const todayAlerts = visible.filter((a) => isToday(a.detectedAt));
  const earlierAlerts = visible.filter((a) => !isToday(a.detectedAt));

  return (
    <main className="min-h-screen px-4 py-5">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-white">Alerts</h1>
          {unreadCount > 0 ? (
            <span className="rounded-md bg-pulse-accent px-2 py-0.5 text-[10px] font-bold uppercase text-white">
              {unreadCount} New
            </span>
          ) : null}
        </div>
        {unreadCount > 0 ? (
          <button
            type="button"
            onClick={markAllRead}
            className="mt-2 text-sm font-semibold text-pulse-accent"
          >
            Mark all read
          </button>
        ) : null}
      </header>

      <div className="mb-5 flex rounded-xl border border-pulse-border bg-pulse-surface p-1">
        <button
          type="button"
          onClick={() => setTab("all")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-bold uppercase tracking-wide transition-colors ${
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
          className={`relative flex-1 rounded-lg py-2.5 text-sm font-bold uppercase tracking-wide transition-colors ${
            tab === "unread"
              ? "bg-pulse-accent text-white"
              : "text-pulse-muted hover:text-white"
          }`}
        >
          Unread
          {unreadCount > 0 && tab !== "unread" ? (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
              {unreadCount}
            </span>
          ) : null}
        </button>
      </div>

      {visible.length === 0 ? (
        tab === "unread" ? (
          <FeedEmptyState
            icon="🔔"
            title="You're all caught up"
            description="Unread alerts from whales you follow will show up here when they enter or exit a play."
          />
        ) : (
          <FeedEmptyState
            icon="🔔"
            title="No alerts yet"
            description="Add whales to your watchlist and you'll see their entries and exits here in real time."
            actionLabel="Go to Watchlist"
            actionHref="/following"
          />
        )
      ) : (
        <div className="rounded-2xl border border-pulse-border bg-pulse-card px-2">
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
        </div>
      )}
    </main>
  );
}

export default function AlertsPage() {
  const { whales } = useWhaleFeed();

  return (
    <LiveFeedPlatformProvider>
      <MobileAppShell>
        <TraderAlertSync whales={whales} />
        <AlertsContent />
      </MobileAppShell>
    </LiveFeedPlatformProvider>
  );
}
