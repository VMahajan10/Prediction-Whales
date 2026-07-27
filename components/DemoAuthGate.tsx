"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import DemoAuthScreen from "@/components/DemoAuthScreen";
import { sanitizeRedirectPath } from "@/lib/authRedirect";
import { DemoAuthProvider, useDemoAuth } from "@/lib/DemoAuthGateContext";

function DemoAuthGatePlaceholder() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-pulse-bg">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-pulse-accent border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

function DemoAuthGateInner({ children }: { children: ReactNode }) {
  const { entered, checking } = useDemoAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [mode, setMode] = useState<"signup" | "login">(
    pathname === "/login" ? "login" : "signup"
  );
  const [hasMounted, setHasMounted] = useState(false);

  const redirectTo = sanitizeRedirectPath(searchParams.get("redirectTo"));

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!hasMounted || checking || entered) return;
    if (!pathname.startsWith("/review/")) return;

    const query = searchParams.toString();
    const target = query ? `${pathname}?${query}` : pathname;
    router.replace(`/login?redirectTo=${encodeURIComponent(target)}`);
  }, [hasMounted, checking, entered, pathname, searchParams, router]);

  // Server + first client paint must match — defer auth branching until mounted.
  if (!hasMounted || checking) {
    return <DemoAuthGatePlaceholder />;
  }

  if (!entered) {
    if (pathname.startsWith("/review/")) {
      return <DemoAuthGatePlaceholder />;
    }

    return (
      <DemoAuthScreen
        mode={pathname === "/login" ? "login" : mode}
        redirectTo={redirectTo}
        onToggleMode={() =>
          setMode((m) => (m === "signup" ? "login" : "signup"))
        }
      />
    );
  }

  return <>{children}</>;
}

export default function DemoAuthGate({ children }: { children: ReactNode }) {
  return (
    <DemoAuthProvider>
      <Suspense fallback={<DemoAuthGatePlaceholder />}>
        <DemoAuthGateInner>{children}</DemoAuthGateInner>
      </Suspense>
    </DemoAuthProvider>
  );
}
