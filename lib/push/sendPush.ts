import "server-only";

import { deleteDeviceToken, listDeviceTokens } from "@/lib/push/deviceTokenStore";
import { sendApnsPush, isApnsConfigured } from "@/lib/push/apns";
import { sendFcmPush, isFcmConfigured } from "@/lib/push/fcm";
import type { PushMessagePayload, PushSendResult } from "@/lib/push/types";

const INVALID_TOKEN_PATTERNS = [
  /registration-token-not-registered/i,
  /invalid-registration-token/i,
  /notregistered/i,
  /unregistered/i,
  /baddevicetoken/i,
  /devicetokennotfor topic/i,
];

function isInvalidTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return INVALID_TOKEN_PATTERNS.some((pattern) => pattern.test(message));
}

export function isPushDeliveryConfigured(): boolean {
  return isFcmConfigured() || isApnsConfigured();
}

export async function sendPushToDevice(
  platform: "ios" | "android",
  token: string,
  payload: PushMessagePayload
): Promise<void> {
  if (platform === "android") {
    if (!isFcmConfigured()) {
      throw new Error("FCM is not configured");
    }
    await sendFcmPush(token, payload);
    return;
  }

  if (!isApnsConfigured()) {
    throw new Error("APNs is not configured");
  }
  await sendApnsPush(token, payload);
}

/**
 * Fan out a push alert to every registered native device token.
 * Invalid tokens are pruned from the store.
 */
export async function sendPushToAllDevices(
  payload: PushMessagePayload
): Promise<PushSendResult> {
  const tokens = await listDeviceTokens();
  if (tokens.length === 0) {
    return { sent: 0, failed: 0, skipped: tokens.length };
  }

  if (!isPushDeliveryConfigured()) {
    console.warn(
      "[push] sendPushToAllDevices skipped — configure FCM and/or APNs env vars"
    );
    return { sent: 0, failed: 0, skipped: tokens.length };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  await Promise.all(
    tokens.map(async ({ token, platform }) => {
      if (platform === "android" && !isFcmConfigured()) {
        skipped += 1;
        return;
      }
      if (platform === "ios" && !isApnsConfigured()) {
        skipped += 1;
        return;
      }

      try {
        await sendPushToDevice(platform, token, payload);
        sent += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `[push] delivery failed platform=${platform} token=${token.slice(0, 12)}…`,
          error instanceof Error ? error.message : error
        );
        if (isInvalidTokenError(error)) {
          await deleteDeviceToken(token);
        }
      }
    })
  );

  return { sent, failed, skipped };
}
