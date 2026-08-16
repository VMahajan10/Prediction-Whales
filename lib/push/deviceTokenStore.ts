import "server-only";

import { getPrisma } from "@/lib/prisma";
import type { DeviceTokenRecord, PushPlatform } from "@/lib/push/types";

const memoryTokens = new Map<string, DeviceTokenRecord>();

function isPushPlatform(value: string): value is PushPlatform {
  return value === "ios" || value === "android";
}

export function normalizeDeviceToken(token: string): string {
  return token.trim();
}

export async function upsertDeviceToken(
  token: string,
  platform: PushPlatform
): Promise<DeviceTokenRecord> {
  const normalized = normalizeDeviceToken(token);
  if (!normalized) {
    throw new Error("Device token is required");
  }

  const prisma = getPrisma();
  if (prisma) {
    const row = await prisma.deviceToken.upsert({
      where: { token: normalized },
      create: { token: normalized, platform },
      update: { platform },
    });
    return {
      token: row.token,
      platform: row.platform as PushPlatform,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  const now = new Date();
  const existing = memoryTokens.get(normalized);
  const record: DeviceTokenRecord = {
    token: normalized,
    platform,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  memoryTokens.set(normalized, record);
  return record;
}

export async function listDeviceTokens(): Promise<DeviceTokenRecord[]> {
  const prisma = getPrisma();
  if (prisma) {
    const rows = await prisma.deviceToken.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return rows
      .filter((row) => isPushPlatform(row.platform))
      .map((row) => ({
        token: row.token,
        platform: row.platform as PushPlatform,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }

  return Array.from(memoryTokens.values());
}

export async function deleteDeviceToken(token: string): Promise<boolean> {
  const normalized = normalizeDeviceToken(token);
  if (!normalized) return false;

  const prisma = getPrisma();
  if (prisma) {
    const result = await prisma.deviceToken.deleteMany({
      where: { token: normalized },
    });
    return result.count > 0;
  }

  return memoryTokens.delete(normalized);
}
