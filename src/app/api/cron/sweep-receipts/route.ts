// Scheduled orphan-receipt sweep (#183). Replaces the Firebase
// Functions sweeper: receipt orphan status is now decided by Postgres
// registration_submissions, which Functions could not reach without a
// second copy of the DB credentials.
//
// Scheduled via vercel.json crons. Vercel sends Authorization:
// Bearer $CRON_SECRET on cron invocations; the check fails closed when
// the variable is unset so the route is never publicly callable.

import { NextRequest, NextResponse } from "next/server";
import { adminReceiptBucket } from "@/lib/firebase-admin";
import { getRegistryDb } from "@/lib/db/client";
import { sweepOrphanedReceipts } from "@/lib/registry/receipt-sweep";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const counts = await sweepOrphanedReceipts({
      bucket: adminReceiptBucket(),
      db: getRegistryDb(),
    });
    const ok = counts.failed === 0;
    return NextResponse.json({ ok, counts }, { status: ok ? 200 : 500 });
  } catch (error) {
    logError("receipt", "sweep-receipts", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
