import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isRoutineRequestPath } from "@/lib/logger";
import { isPublicReviewPath } from "@/lib/publicRoutes";

/**
 * Review editor links are public — no auth redirect for /review/[id].
 * Client demo auth gate also skips these paths (see DemoAuthGate).
 * Health/ping/polling paths are skipped so they never pick up request telemetry.
 */
export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    if (isRoutineRequestPath(pathname) || isPublicReviewPath(pathname)) {
        return NextResponse.next();
    }

    return NextResponse.next();
}

export const config = {
  matcher: ["/review/:path*"],
};
