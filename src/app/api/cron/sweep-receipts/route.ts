// Scheduled orphan-object sweep (#183 receipts, #192 clinical
// documents). Replaces the Firebase Functions sweeper: orphan status is
// now decided by Postgres rows (registration_submissions,
// vet_documents), which Functions could not reach without a second copy
// of the DB credentials. One cron pass covers both private prefixes.
//
// Scheduled via vercel.json crons. Vercel sends Authorization:
// Bearer $CRON_SECRET on cron invocations; the check fails closed when
// the variable is unset so the route is never publicly callable.
//
// Preview deployments are refused outright (#271): the sweep deletes
// objects from the SHARED production Storage bucket using the preview
// Neon branch's rows as the orphan oracle — data divergence between
// the branch and production would make real objects look orphaned.
// Vercel only schedules crons on production anyway, so nothing
// legitimate is lost.

import { NextRequest, NextResponse } from "next/server";
import { adminReceiptBucket } from "@/lib/firebase-admin-storage";
import { getRegistryDb } from "@/lib/db/client";
import { sweepOrphanedReceipts } from "@/lib/registry/receipt-sweep";
import { sweepOrphanedVetDocuments } from "@/lib/registry/vet-document-sweep";
import { getAppLifecycle } from "@/lib/app-lifecycle";
import { APP_LIFECYCLE_PRELAUNCH_DEMO } from "@/lib/app-lifecycle-label";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (process.env.VERCEL_ENV === "preview") {
    return NextResponse.json(
      { ok: false, error: "cron routes do not run on preview deployments" },
      { status: 403 },
    );
  }

  try {
    // Pre-launch demo guard (#275): the orphan oracle is Postgres rows —
    // during the demo window everything deletable would be a demo object
    // anyway, and the demo reset already reclaims them. Skipping the
    // sweep outright is the fail-closed choice: no object can be
    // deleted by a scheduled run while fictional data is live.
    const lifecycle = await getAppLifecycle();
    if (lifecycle === APP_LIFECYCLE_PRELAUNCH_DEMO) {
      return NextResponse.json({ ok: true, skipped: "prelaunch-demo" });
    }

    const db = getRegistryDb();
    const bucket = adminReceiptBucket();
    const [receipts, vetDocs] = await Promise.all([
      sweepOrphanedReceipts({ bucket, db }),
      sweepOrphanedVetDocuments({ bucket, db }),
    ]);
    const ok = receipts.failed === 0 && vetDocs.failed === 0;
    return NextResponse.json(
      { ok, counts: { receipts, vetDocs } },
      { status: ok ? 200 : 500 },
    );
  } catch (error) {
    logError("receipt", "sweep-receipts", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
