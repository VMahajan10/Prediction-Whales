"use client";

import type { ReactNode } from "react";
import { usePushNotifications } from "@/hooks/usePushNotifications";

export default function PushNotificationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  usePushNotifications();
  return <>{children}</>;
}
