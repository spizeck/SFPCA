// Staff CSV export (#179) — GET /admin/reports/export?report=&year=&asof=
//
// Route handlers are NOT wrapped by the admin layout, so this handler
// runs requireAdmin() itself — the session-cookie proxy is never the
// authorization boundary. Exports contain aggregate report data only
// (no owner-level rows); the download is written to audit_events as a
// data-egress record. Response is no-store: staff numbers must never
// be cached into shared/public artifacts.

import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRegistryDb } from "@/lib/db/client";
import { auditEvents } from "@/lib/db/schema";
import {
  buildExportCsv,
  getStaffReport,
  isExportReportKey,
} from "@/lib/registry/reports";
import { logError } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const { authorized, user } = await requireAdmin();
  if (!authorized) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const kind = params.get("report");
  if (!isExportReportKey(kind)) {
    return new NextResponse("Unknown report", { status: 400 });
  }
  const rawYear = params.get("year");
  const year = rawYear === null ? undefined : Number(rawYear);
  if (rawYear !== null && !Number.isInteger(year)) {
    return new NextResponse("Invalid year", { status: 400 });
  }
  const asOf = params.get("asof") ?? undefined;

  try {
    const db = getRegistryDb();
    const report = await getStaffReport({ year, asOf }, db);
    const csv = buildExportCsv(report, kind);

    // Audit the egress — filters and report kind only, never the
    // exported content.
    await db.insert(auditEvents).values({
      actorLabel: user?.email ?? "unknown",
      entityType: "report_export",
      entityId: `${kind}/${report.year}/${report.asOf}`,
      action: "export",
      after: { report: kind, year: report.year, asOf: report.asOf },
    });

    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="sfpca-${kind}-report-${report.year}-${report.asOf}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    logError("reports", "export", error);
    return new NextResponse("Export failed", { status: 500 });
  }
}
