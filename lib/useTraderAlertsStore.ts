"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getTraderAlerts,
  getUnreadAlertCount,
  markAlertRead,
  markAllAlertsRead,
  TRADER_ALERTS_CHANGED_EVENT,
  type TraderAlert,
} from "@/lib/traderAlerts";

export function useTraderAlertsStore() {
  const [alerts, setAlerts] = useState<TraderAlert[]>(() =>
    typeof window !== "undefined" ? getTraderAlerts() : []
  );

  const refresh = useCallback(() => {
    setAlerts(getTraderAlerts());
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(TRADER_ALERTS_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(TRADER_ALERTS_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [refresh]);

  const unreadCount = alerts.filter((a) => !a.read).length;

  const markRead = useCallback(
    (id: string) => {
      markAlertRead(id);
      refresh();
    },
    [refresh]
  );

  const markAllRead = useCallback(() => {
    markAllAlertsRead();
    refresh();
  }, [refresh]);

  return {
    alerts,
    unreadCount,
    markRead,
    markAllRead,
    refresh,
  };
}

export function getStoredUnreadAlertCount(): number {
  return getUnreadAlertCount();
}
