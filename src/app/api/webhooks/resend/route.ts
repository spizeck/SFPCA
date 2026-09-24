// Resend delivery webhooks (#172) — provider-side outcomes written back
// onto the authoritative communications rows.
//
// Every request is signature-verified (svix HMAC over the raw body with
// the whsec_… secret, plus a replay-timestamp window). The route fails
// closed: no secret configured → it answers 503 rather than accepting
// unverifiable payloads.
//
// Processing is idempotent: events are matched by provider message id
// and only forward transitions apply, so Resend's at-least-once
// redelivery and retries are safe. Unknown message ids are acknowledged
// (200) and logged — erroring would only trigger retry storms for mail
// this deployment genuinely cannot reconcile.

import { NextRequest, NextResponse } from "next/server";
import { getRegistryDb } from "@/lib/db/client";
import { verifyResendWebhookSignature } from "@/lib/email";
import {
  markCommunicationDelivered,
  markCommunicationFailed,
} from "@/lib/registry/communications";
import { logError, logWarn } from "@/lib/logger";

export const dynamic = "force-dynamic";

// The webhook event types we act on. Everything else (sent/opened/
// clicked/delayed) is acknowledged and ignored — delivery truth lives
// on the row, not in the provider's event stream.
const EVENT_DETAIL: Record<string, "delivered" | string> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.failed": "delivery-failed",
  "email.complained": "complained",
};

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  // Signature verification needs the exact raw body — parsing first
  // would break the HMAC.
  const payload = await request.text();
  const valid = verifyResendWebhookSignature({
    payload,
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    secret,
  });
  if (!valid) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  let event: { type?: unknown; data?: { email_id?: unknown } };
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const outcome = typeof event.type === "string" ? EVENT_DETAIL[event.type] : undefined;
  const emailId =
    typeof event.data?.email_id === "string" ? event.data.email_id : null;
  if (!outcome || !emailId) {
    // Verified but not actionable — acknowledge without erroring.
    return NextResponse.json({ ok: true, handled: false });
  }

  try {
    const changed =
      outcome === "delivered"
        ? await markCommunicationDelivered(emailId, new Date(), getRegistryDb())
        : await markCommunicationFailed(emailId, outcome, new Date(), getRegistryDb());
    if (changed === 0) {
      // Either a duplicate delivery (already applied) or a message id
      // this ledger never sent — neither is an incident.
      logWarn("communications", "resend-webhook", "event matched no live row", {
        eventType: typeof event.type === "string" ? event.type : "unknown",
      });
    }
    return NextResponse.json({ ok: true, handled: changed > 0 });
  } catch (error) {
    logError("communications", "resend-webhook", error, {
      eventType: typeof event.type === "string" ? event.type : "unknown",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
