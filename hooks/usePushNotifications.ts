"use client";

import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import {
  PushNotifications,
  type ActionPerformed,
  type Token,
} from "@capacitor/push-notifications";

type PushPlatform = "ios" | "android";

async function registerTokenWithServer(
  token: string,
  platform: PushPlatform
): Promise<void> {
  const res = await fetch("/api/push/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, platform }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Token registration failed (${res.status})`);
  }
}

function resolvePlatform(): PushPlatform {
  return Capacitor.getPlatform() === "ios" ? "ios" : "android";
}

function navigateFromNotification(action: ActionPerformed): void {
  const data = action.notification.data ?? {};
  const path =
    typeof data.path === "string" && data.path.startsWith("/")
      ? data.path
      : typeof data.transactionHash === "string"
        ? `/whales/${encodeURIComponent(data.transactionHash)}`
        : null;

  if (!path || typeof window === "undefined") return;
  window.location.assign(path);
}

/**
 * Registers the native device for APNs/FCM push and uploads the token to the API.
 * No-ops on web builds.
 */
export function usePushNotifications(): void {
  const started = useRef(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    const platform = resolvePlatform();
    const listenerHandles: Array<{ remove: () => Promise<void> }> = [];

    const setup = async () => {
      try {
        const permission = await PushNotifications.requestPermissions();
        if (cancelled) return;
        if (permission.receive !== "granted") {
          console.info("[push] notification permission not granted");
          return;
        }

        const registrationListener = await PushNotifications.addListener(
          "registration",
          async (event: Token) => {
            if (!event.value || cancelled) return;
            try {
              await registerTokenWithServer(event.value, platform);
              console.info("[push] device token registered");
            } catch (error) {
              console.error(
                "[push] token registration failed",
                error instanceof Error ? error.message : error
              );
            }
          }
        );
        listenerHandles.push(registrationListener);

        const registrationErrorListener =
          await PushNotifications.addListener("registrationError", (error) => {
            console.error("[push] registration error", error);
          });
        listenerHandles.push(registrationErrorListener);

        const actionListener = await PushNotifications.addListener(
          "pushNotificationActionPerformed",
          (action) => {
            navigateFromNotification(action);
          }
        );
        listenerHandles.push(actionListener);

        await PushNotifications.register();
      } catch (error) {
        console.error(
          "[push] setup failed",
          error instanceof Error ? error.message : error
        );
      }
    };

    void setup();

    return () => {
      cancelled = true;
      void Promise.all(listenerHandles.map((handle) => handle.remove()));
    };
  }, []);
}
