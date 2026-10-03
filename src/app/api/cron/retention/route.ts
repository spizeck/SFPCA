// Scheduled retention pass (#130): verified receipts past 90 days,
// abandoned/unsuccessful submissions past 12 months, and completed
// records whose PII ages out 7 years after the registration year ends.
// Policy lives in src/lib/retention.ts + src/lib/registry/retention.ts —
// this route is only auth, environment gating, and result reporting.
//
// Scheduled via vercel.json crons. Vercel sends Authorization:
// Bearer $CRON_SECRET on cron invocations; the check fails closed when
// the variable is unset so the route is never publicly callable.
//
// Rollout gate: destructive runs require RETENTION_PURGE_ENABLED=true.
// Until then every invocation runs in dry-run mode and only reports
// counts — deploy, inspect, then enable.
//
// ?dry_run=1 reports what WOULD be purged/anonymized without writing
// anything (also how operators preview before enabling the flag).
// ?as_of=YYYY-MM-DD makes a run reproducible.
//
// Preview deployments are refused live runs outright (#271): a preview
// pass would delete objects from the SHARED production Storage bucket
// and rows judged against the preview Neon branch's data. dry_run stays
// available for preview verification; Vercel only schedules crons on
// production anyway.

import { NextRequest, NextResponse } from "next/server";
import { adminReceiptBucket } from "@/lib/firebase-admin-storage";
import { getRegistryDb } from "@/lib/db/client";
import { runRetentionPass } from "@/lib/registry/retention";
import {
  isRetentionPurgeEnabled,
  RETENTION_BATCH_LIMIT,
} from "@/lib/retention";
import { isIsoDateString, todayIsoDate } from "@/lib/vaccinations";
import { getAppLifecycleStrict } from "@/lib/app-lifecycle";
import { APP_LIFECYCLE_LIVE } from "@/lib/app-lifecycle-label";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const dryRunRequested =
    params.get("dry_run") === "1" || params.get("dry_run") === "true";
  const asOfParam = params.get("as_of");
  const asOf = asOfParam ?? todayIsoDate();
  if (asOfParam !== null && !isIsoDateString(asOfParam)) {
    return NextResponse.json(
      { ok: false, error: "as_of must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const purgeEnabled = isRetentionPurgeEnabled();
  // A future as_of on a live run would make receipts/submissions
  // eligible before their actual deadline — allow it only for
  // read-only passes.
  if (!dryRunRequested && purgeEnabled && asOf > todayIsoDate()) {
    return NextResponse.json(
      { ok: false, error: "as_of may not be in the future on a live run" },
      { status: 400 },
    );
  }
  if (process.env.VERCEL_ENV === "preview" && !dryRunRequested) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "live retention runs are disabled on preview deployments (dry_run=1 still works)",
      },
      { status: 403 },
    );
  }
  // Report-only until the flag is set — a scheduled run before rollout
  // produces the same counts as an explicit dry run.
  const dryRun = dryRunRequested || !purgeEnabled;

  // Pre-launch demo guard (#276): no scheduled deletion while fictional
  // data is live — the demo reset already reclaims demo objects, and an
  // unreadable lifecycle must not resolve 'live' and unleash a purge
  // during a demo-window outage. Dry runs stay available (report only).
  const lifecycle = await getAppLifecycleStrict();
  if (lifecycle !== APP_LIFECYCLE_LIVE && !dryRun) {
    return NextResponse.json({
      ok: true,
      skipped: lifecycle ?? "lifecycle-unreadable",
    });
  }

  try {
    const result = await runRetentionPass({
      db: getRegistryDb(),
      bucket: adminReceiptBucket(),
      now: new Date(`${asOf}T00:00:00Z`),
      dryRun,
      batchSize: RETENTION_BATCH_LIMIT,
    });
    const failed =
      result.receipts.failed +
      result.abandonedSubmissions.failed +
      result.completedRecords.failed;
    return NextResponse.json(
      { ok: failed === 0, purgeEnabled, result },
      { status: failed === 0 ? 200 : 500 },
    );
  } catch (error) {
    logError("retention", "retention-cron", error, { asOf });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
