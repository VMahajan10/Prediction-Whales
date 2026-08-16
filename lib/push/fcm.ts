import "server-only";

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import type { PushMessagePayload } from "@/lib/push/types";

let firebaseApp: App | null = null;
let messagingClient: Messaging | null = null;

function readFirebasePrivateKey(): string | null {
  const raw = process.env.FIREBASE_PRIVATE_KEY?.trim();
  if (!raw) return null;
  return raw.replace(/\\n/g, "\n");
}

export function isFcmConfigured(): boolean {
  return !!(
    process.env.FIREBASE_PROJECT_ID?.trim() &&
    process.env.FIREBASE_CLIENT_EMAIL?.trim() &&
    readFirebasePrivateKey()
  );
}

function getMessagingClient(): Messaging | null {
  if (!isFcmConfigured()) return null;
  if (messagingClient) return messagingClient;

  if (!firebaseApp) {
    const existing = getApps()[0];
    firebaseApp =
      existing ??
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID!.trim(),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL!.trim(),
          privateKey: readFirebasePrivateKey()!,
        }),
      });
  }

  messagingClient = getMessaging(firebaseApp);
  return messagingClient;
}

export async function sendFcmPush(
  token: string,
  payload: PushMessagePayload
): Promise<void> {
  const messaging = getMessagingClient();
  if (!messaging) {
    throw new Error("FCM is not configured");
  }

  await messaging.send({
    token,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
    android: {
      priority: "high",
      notification: {
        channelId: "whale_alerts",
      },
    },
  });
}
