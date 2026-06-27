"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  clearDemoEntered,
  DEMO_AUTH_CHANGED_EVENT,
  hasDemoEntered,
  setDemoEntered,
} from "@/lib/demoAuthGate";

interface DemoAuthContextValue {
  entered: boolean;
  checking: boolean;
  enter: () => void;
  logout: () => void;
}

const DemoAuthContext = createContext<DemoAuthContextValue | null>(null);

export function DemoAuthProvider({ children }: { children: ReactNode }) {
  const [entered, setEntered] = useState(false);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(() => {
    setEntered(hasDemoEntered());
    setChecking(false);
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(DEMO_AUTH_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DEMO_AUTH_CHANGED_EVENT, onChange);
  }, [refresh]);

  const enter = useCallback(() => {
    setDemoEntered();
    setEntered(true);
    setChecking(false);
  }, []);

  const logout = useCallback(() => {
    clearDemoEntered();
    setEntered(false);
    setChecking(false);
  }, []);

  const value = useMemo(
    () => ({ entered, checking, enter, logout }),
    [entered, checking, enter, logout]
  );

  return (
    <DemoAuthContext.Provider value={value}>{children}</DemoAuthContext.Provider>
  );
}

export function useDemoAuth(): DemoAuthContextValue {
  const ctx = useContext(DemoAuthContext);
  if (!ctx) {
    throw new Error("useDemoAuth must be used within DemoAuthProvider");
  }
  return ctx;
}
