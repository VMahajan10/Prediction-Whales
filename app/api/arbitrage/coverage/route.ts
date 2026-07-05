import { NextRequest, NextResponse } from "next/server";
import { getArbScanMeta } from "@/lib/arbitrageFinder/cache/windowCache";
import { collectArbitrageScanCoverage } from "@/lib/arbitrageFinder/observability/scanCoverage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const fresh = params.get("fresh") === "true";
    const mappingLimitRaw = params.get("mappingLimit");
    const mappingLimit = mappingLimitRaw
      ? parseInt(mappingLimitRaw, 10)
      : undefined;
    const resolvedLimit = Number.isFinite(mappingLimit) ? mappingLimit : undefined;

    if (!fresh) {
      const cached = await getArbScanMeta();
      if (cached?.report) {
        return NextResponse.json({
          report: cached.report,
          recordedAt: cached.recordedAt,
          fromCache: true,
        });
      }
    }

    const report = await collectArbitrageScanCoverage({
      mappingLimit: resolvedLimit,
      recordMeta: true,
      logSummary: false,
    });
    const meta = await getArbScanMeta();

    return NextResponse.json({
      report,
      recordedAt: meta?.recordedAt ?? report.scannedAt,
      fromCache: false,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Arbitrage coverage fetch failed";
    console.error("[api/arbitrage/coverage] GET failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    let body: { mappingLimit?: number; logSummary?: boolean } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      // Empty body is fine for a default scan.
    }

    const report = await collectArbitrageScanCoverage({
      mappingLimit: body.mappingLimit,
      recordMeta: true,
      logSummary: body.logSummary ?? true,
    });

    const meta = await getArbScanMeta();

    return NextResponse.json({
      report,
      recordedAt: meta?.recordedAt ?? report.scannedAt,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Arbitrage coverage scan failed";
    console.error("[api/arbitrage/coverage] POST failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
