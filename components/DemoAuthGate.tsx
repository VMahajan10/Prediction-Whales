"use client";

import { useState, type ReactNode } from "react";
import DemoAuthScreen from "@/components/DemoAuthScreen";
import { DemoAuthProvider, useDemoAuth } from "@/lib/DemoAuthGateContext";

function DemoAuthGateInner({ children }: { children: ReactNode }) {
  const { entered, checking } = useDemoAuth();
  const [mode, setMode] = useState<"signup" | "login">("signup");

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-pulse-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-pulse-accent border-t-transparent" />
      </div>
    );
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
