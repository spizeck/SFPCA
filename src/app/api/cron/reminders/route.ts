// Scheduled reminder evaluation + delivery (#172). Runs the canonical
// evaluators against Postgres, queues reminders into the
// communications ledger, then drains the queue through the configured
// email provider — all server-side, no browser session involved.
//
// Scheduled via vercel.json crons. Vercel sends Authorization:
// Bearer $CRON_SECRET on cron invocations; the check fails closed when
// the variable is unset so the route is never publicly callable.
//
// ?dry_run=1 evaluates eligibility and reports what WOULD be queued or
// skipped without writing anything or sending — the operator-facing
// dry run. It works without a provider configured; a live run refuses
// (503) when RESEND_API_KEY/EMAIL_FROM are unset rather than silently
// queueing work that can never go out.

import { NextRequest, NextResponse } from "next/server";
import { createResendSender } from "@/lib/email";
import { runReminderCycle } from "@/lib/registry/reminders";
import { isIsoDateString, todayIsoDate } from "@/lib/vaccinations";
import { logError, logWarn } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const dryRun = params.get("dry_run") === "1" || params.get("dry_run") === "true";
  // An explicit as_of makes a run reproducible; malformed input fails
  // loudly rather than evaluating "today" by surprise.
  const asOfParam = params.get("as_of");
  const asOf = asOfParam ?? todayIsoDate();
  if (asOfParam !== null && !isIsoDateString(asOfParam)) {
    return NextResponse.json(
      { ok: false, error: "as_of must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const sender = dryRun ? null : createResendSender();
  if (!dryRun && !sender) {
    logWarn("communications", "reminder-cron", "email provider not configured");
    return NextResponse.json(
      { ok: false, error: "email provider not configured" },
      { status: 503 },
    );
  }

  try {
    const result = await runReminderCycle({ asOf, dryRun, sender });
    const failures =
      result.delivery === "dry-run" || result.delivery === "not-configured"
        ? 0
        : result.delivery.failed + result.delivery.malformed;
    if (failures > 0) {
      logWarn("communications", "reminder-cron", "delivery failures", {
        asOf,
        failures,
      });
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    logError("communications", "reminder-cron", error, { asOf });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
