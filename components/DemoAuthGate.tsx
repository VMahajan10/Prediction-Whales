"use client";

import { useEffect, useState, type ReactNode } from "react";
import DemoAuthScreen from "@/components/DemoAuthScreen";
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
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Server + first client paint must match — defer auth branching until mounted.
  if (!hasMounted || checking) {
    return <DemoAuthGatePlaceholder />;
  }

  if (!entered) {
    return (
      <DemoAuthScreen
        mode={mode}
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
      <DemoAuthGateInner>{children}</DemoAuthGateInner>
    </DemoAuthProvider>
  );
}
