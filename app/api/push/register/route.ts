import { NextRequest, NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  normalizeDeviceToken,
  upsertDeviceToken,
} from "@/lib/push/deviceTokenStore";
import type { PushPlatform } from "@/lib/push/types";
import { isPrismaEnabled } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface RegisterBody {
  token?: string;
  platform?: string;
}

function parsePlatform(value: string | undefined): PushPlatform | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "ios" || normalized === "android") {
    return normalized;
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RegisterBody;
    const token = normalizeDeviceToken(body.token ?? "");
    const platform = parsePlatform(body.platform);

    if (!token) {
      return NextResponse.json({ error: "token is required" }, { status: 400 });
    }
    if (!platform) {
      return NextResponse.json(
        { error: "platform must be ios or android" },
        { status: 400 }
      );
    }

    const record = await upsertDeviceToken(token, platform);

    return NextResponse.json({
      ok: true,
      token: record.token,
      platform: record.platform,
      persisted: isPrismaEnabled(),
      updatedAt: record.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("[api/push/register]", error);
    return NextResponse.json(
      {
        error: publicApiErrorMessage(error, "Failed to register device token"),
      },
      { status: 500 }
    );
  }
}
