import "server-only";

import { connect } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
import type { PushMessagePayload } from "@/lib/push/types";

function readApnsPrivateKey(): string | null {
  const raw = process.env.APNS_PRIVATE_KEY?.trim();
  if (!raw) return null;
  return raw.replace(/\\n/g, "\n");
}

export function isApnsConfigured(): boolean {
  return !!(
    process.env.APNS_KEY_ID?.trim() &&
    process.env.APNS_TEAM_ID?.trim() &&
    process.env.APNS_BUNDLE_ID?.trim() &&
    readApnsPrivateKey()
  );
}

function apnsHost(): string {
  const production = process.env.APNS_PRODUCTION === "true";
  return production
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com";
}

let cachedJwt: { token: string; expiresAt: number } | null = null;

function buildApnsJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expiresAt > now + 60) {
    return cachedJwt.token;
  }

  const keyId = process.env.APNS_KEY_ID!.trim();
  const teamId = process.env.APNS_TEAM_ID!.trim();
  const privateKey = readApnsPrivateKey()!;

  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: keyId })
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss: teamId, iat: now })
  ).toString("base64url");
  const unsigned = `${header}.${claims}`;

  const signer = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  });
  const signature = signer.toString("base64url");
  const token = `${unsigned}.${signature}`;

  cachedJwt = { token, expiresAt: now + 50 * 60 };
  return token;
}

export async function sendApnsPush(
  deviceToken: string,
  payload: PushMessagePayload
): Promise<void> {
  if (!isApnsConfigured()) {
    throw new Error("APNs is not configured");
  }

  const bundleId = process.env.APNS_BUNDLE_ID!.trim();
  const jwt = buildApnsJwt();
  const body = JSON.stringify({
    aps: {
      alert: {
        title: payload.title,
        body: payload.body,
      },
      sound: "default",
    },
    ...payload.data,
  });

  await new Promise<void>((resolve, reject) => {
    const client = connect(`https://${apnsHost()}`);

    const fail = (error: Error) => {
      client.close();
      reject(error);
    };

    client.on("error", fail);

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });

    const chunks: Buffer[] = [];
    req.on("response", (headers) => {
      const status = Number(headers[":status"] ?? 500);
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        client.close();
        if (status >= 200 && status < 300) {
          resolve();
          return;
        }
        const detail = Buffer.concat(chunks).toString("utf8");
        reject(new Error(`APNs HTTP ${status}: ${detail || "send failed"}`));
      });
    });

    req.end(body);
  });
}
