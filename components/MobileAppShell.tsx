"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface MobileAppShellProps {
  children: ReactNode;
  /** Show compact mobile bottom nav */
  showNav?: boolean;
}

const NAV_ITEMS = [
  { href: "/", label: "Feed", icon: "📡" },
  { href: "/following", label: "Watchlist", icon: "◎" },
  { href: "/alerts", label: "Alerts", icon: "🔔" },
] as const;

export default function MobileAppShell({
  children,
  showNav = true,
}: MobileAppShellProps) {
  const pathname = usePathname();

  return (
    <div className="mx-auto min-h-screen max-w-md bg-pulse-bg lg:max-w-lg">
      <div className={showNav ? "pb-24 pb-safe-bottom" : ""}>{children}</div>

      {showNav && (
        <nav className="fixed bottom-0 left-1/2 z-50 w-full max-w-md -translate-x-1/2 border-t border-pulse-border bg-black/95 pb-safe-bottom backdrop-blur lg:max-w-lg">
          <div className="flex items-stretch justify-around px-2 py-2">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                    active
                      ? "text-pulse-accent"
                      : "text-pulse-label hover:text-pulse-muted"
                  }`}
                >
                  <span className="text-base leading-none">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
