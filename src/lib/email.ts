import "server-only";

// Outbound email delivery for the reminder pipeline (#172).
//
// Provider: Resend — the smallest server-side integration that fits the
// existing Vercel/Next.js stack (HTTPS API, no SMTP infrastructure,
// provider-side idempotency keys, signed delivery webhooks). The
// sender is deliberately a narrow interface so tests inject a fake and
// the domain service never imports the SDK.
//
// Env:
//   RESEND_API_KEY         — server-only secret; unset → no sender
//   EMAIL_FROM             — verified sender identity, e.g.
//                            "SFPCA <reminders@sabafpca.com>" — requires
//                            the domain to be verified in Resend
//   RESEND_WEBHOOK_SECRET  — whsec_… signing secret for webhook
//                            verification (optional; without it the
//                            webhook route refuses all requests)
//
// Failure semantics — the distinction that makes retries safe:
//   rejected    the provider answered 4xx/validation — the message was
//               NOT accepted; retrying the same content is pointless
//   unavailable the provider answered 5xx/429 — the message was NOT
//               accepted; safe to retry later, provider confirmed it
//               never went out
//   uncertain   no answer arrived (timeout/network) — the provider may
//               have sent it. Never auto-retried: a duplicate reminder
//               is worse than a delayed one, so the row lands on the
//               staff exception list for manual reconcile/requeue.
//
// Provider-side idempotency: every send carries the communication row's
// uuid as Resend's Idempotency-Key, so a same-day retry of the SAME row
// cannot double-send even if the first response was lost.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type SendOutcome =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      failure: "rejected" | "unavailable" | "uncertain";
      // Bounded machine-readable detail — provider error name, never a
      // message that might echo recipient data.
      detail: string;
    };

export interface EmailSender {
  readonly provider: string;
  send(message: OutboundEmail, idempotencyKey: string): Promise<SendOutcome>;
}

const MAX_DETAIL = 120;

function coarseDetail(value: unknown): string {
  const s = typeof value === "string" ? value : "unknown";
  // Provider error names are short enums; bound the field anyway so a
  // verbose upstream message can never bloat or leak into the ledger.
  return s.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, MAX_DETAIL);
}

// Builds the Resend sender, or null when the provider is not configured.
// Callers treat null as "delivery unavailable" — evaluation can still
// run (dry-run) but nothing sends.
export function createResendSender(
  env: Record<string, string | undefined> = process.env,
): EmailSender | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;

  const resend = new Resend(apiKey);
  return {
    provider: "resend",
    async send(message, idempotencyKey) {
      try {
        const { data, error } = await resend.emails.send(
          {
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          },
          { idempotencyKey },
        );
        if (error) {
          const status = (error as { statusCode?: unknown }).statusCode;
          const failure =
            typeof status === "number" && (status === 429 || status >= 500)
              ? "unavailable"
              : "rejected";
          return {
            ok: false,
            failure,
            detail: coarseDetail(error.name ?? `http-${status ?? "?"}`),
          };
        }
        return { ok: true, providerMessageId: data?.id ?? null };
      } catch (error) {
        // No response — delivery state is unknowable. Classify as
        // uncertain so the pipeline parks the row for staff instead of
        // risking a duplicate send.
        return {
          ok: false,
          failure: "uncertain",
          detail: coarseDetail((error as { name?: unknown })?.name),
        };
      }
    },
  };
}

// --- Webhook verification ------------------------------------------------
// Resend signs webhooks with the svix scheme: HMAC-SHA256 over
// "<svix-id>.<svix-timestamp>.<raw body>" keyed by the base64 payload of
// the whsec_… secret, signatures delivered as "v1,<base64>" entries in
// svix-signature. Implemented directly so verification needs no API key
// and the algorithm is auditable here.

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface WebhookVerificationInput {
  payload: string; // raw request body — never the re-stringified JSON
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowSeconds?: number;
}

export function verifyResendWebhookSignature({
  payload,
  id,
  timestamp,
  signature,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
}: WebhookVerificationInput): boolean {
  if (!id || !timestamp || !signature) return false;
  if (!secret.startsWith("whsec_")) return false;

  // Replay window: reject old/future timestamps before doing any work.
  const ts = Number.parseInt(timestamp, 10);
  if (
    !Number.isFinite(ts) ||
    Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false;
  }

  let key: Buffer;
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  // The header may carry several space-separated "v1,<sig>" candidates
  // (key rotation); a match on any is valid.
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const candidate = Buffer.from(sig, "base64");
    const wanted = Buffer.from(expected, "base64");
    if (
      candidate.length === wanted.length &&
      timingSafeEqual(candidate, wanted)
    ) {
      return true;
    }
  }
  return false;
}
