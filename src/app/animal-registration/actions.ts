"use server";

// Public registration intake (#183, abuse controls #219). The browser
// never reaches Postgres: this action re-validates everything
// server-side and inserts the submission row. There is deliberately no
// authentication — this is the public form — so validation lives
// entirely in the domain service.
//
// Abuse posture (defense in depth):
// - Honeypot: a hidden `website` field that no human or assistive
//   technology fills. A hit returns a fake success shape — nothing is
//   written, and the response is indistinguishable from a real success
//   so the field cannot be probed as a bot oracle.
// - Rate limit: a fixed-window Postgres counter keyed by a salted hash
//   of the trusted client IP (src/lib/request-identity.ts documents the
//   trust boundary). Over-limit attempts get an honest, retryable
//   "throttled" result — the client shows a calm message and preserves
//   the form.
// - Receipt upload: no more direct unauthenticated Storage writes. The
//   action mints a path-bound, short-lived signed URL only after the
//   row lands (or, where no real GCS exists — emulator/dev/mint failure
//   — the client posts the file to finalizeReceiptAction, which saves it
//   through the Admin SDK). storage.rules denies every client write.

import { headers } from "next/headers";
import {
  attachReceiptToSubmission,
  createRegistrationSubmission,
  type SubmissionInput,
} from "@/lib/registry/registrations";
import { checkRateLimit, warnThrottled } from "@/lib/rate-limit";
import { clientIpFromHeaders, subjectForIp } from "@/lib/request-identity";
import { adminReceiptBucket } from "@/lib/firebase-admin-storage";
import {
  isReceiptFile,
  RECEIPT_CONTENT_TYPES,
  RECEIPT_MAX_BYTES,
} from "@/lib/animal-registration";
import { logError, logWarn } from "@/lib/logger";

export interface SubmitRegistrationInput extends SubmissionInput {
  // Honeypot — must arrive empty. Any content marks automated tooling.
  website?: string;
  // Declares intent to attach a receipt so the action can mint the
  // upload entitlement only for submissions that will use it.
  wantsReceipt?: boolean;
}

export type ReceiptUploadGrant =
  | { mode: "signed-url"; url: string }
  | { mode: "server-save" };

export type SubmitRegistrationResult =
  | {
      ok: true;
      submissionId: string;
      receiptUpload: ReceiptUploadGrant | null;
    }
  | { ok: false; reason: "invalid" | "error" | "throttled" };

const RECEIPT_URL_TTL_MS = 15 * 60 * 1000;

async function intakeSubject(): Promise<string> {
  return subjectForIp(clientIpFromHeaders(await headers()));
}

// Mint a path-bound write URL for receipts/<submissionId>. Grants write
// to exactly one object for 15 minutes — acquiring one requires passing
// the honeypot, the rate limit, and validation, so an arbitrary client
// can no longer create receipt objects at will. Storage rules bypassed
// by design: signed URLs are GCS-level authorization.
async function mintReceiptUploadUrl(
  submissionId: string,
): Promise<ReceiptUploadGrant> {
  try {
    // Emulator/dev: there is no real GCS to sign for — the client posts
    // the file to finalizeReceiptAction and the Admin SDK writes it.
    if (process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
      return { mode: "server-save" };
    }
    const [url] = await adminReceiptBucket()
      .file(`receipts/${submissionId}`)
      .getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + RECEIPT_URL_TTL_MS,
      });
    return { mode: "signed-url", url };
  } catch (error) {
    // Entitlement minting failed — the server-save fallback keeps the
    // legitimate flow working; the failure is reported normally.
    logError("receipt", "upload-entitlement", error);
    return { mode: "server-save" };
  }
}

export async function submitRegistrationAction(
  input: SubmitRegistrationInput,
): Promise<SubmitRegistrationResult> {
  // Honeypot first — no limiter hit, no write, generic success shape.
  if (typeof input.website === "string" && input.website.trim() !== "") {
    logWarn(
      "registration",
      "honeypot",
      "Public intake honeypot triggered",
    );
    return {
      ok: true,
      submissionId: input.submissionId ?? "",
      receiptUpload: null,
    };
  }

  const gate = await checkRateLimit(
    "registration.submit",
    await intakeSubject(),
  );
  if (!gate.allowed) {
    warnThrottled("registration", "registration.submit", gate);
    return { ok: false, reason: "throttled" };
  }

  const { website: _hp, wantsReceipt, ...submission } = input;
  try {
    const result = await createRegistrationSubmission(submission);
    if (!result.ok) {
      return { ok: false, reason: "invalid" };
    }
    const receiptUpload = wantsReceipt
      ? await mintReceiptUploadUrl(result.submissionId)
      : null;
    return {
      ok: true,
      submissionId: result.submissionId,
      receiptUpload,
    };
  } catch (error) {
    // Failure contract: a clear retryable error, never a fake success.
    logError("registration", "submit", error);
    return { ok: false, reason: "error" };
  }
}

// Second phase of receipt intake: the submission row already exists (it
// passed validation and the limiter). `file` present → the client is on
// the server-save path (emulator/dev, or mint failure fallback) and the
// Admin SDK writes the object here. `file` absent → the client already
// PUT to the signed URL; we verify the object that actually landed
// before binding its path to the row. Either way the row only ever
// stores the derived receipts/<submissionId> path.
export async function finalizeReceiptAction(input: {
  submissionId: string;
  file?: File | null;
}): Promise<{ ok: boolean; reason?: "invalid" | "throttled" | "error" }> {
  const gate = await checkRateLimit(
    "receipt.finalize",
    await intakeSubject(),
  );
  if (!gate.allowed) {
    warnThrottled("receipt", "receipt.finalize", gate);
    return { ok: false, reason: "throttled" };
  }

  const path = `receipts/${input.submissionId}`;
  const bucket = adminReceiptBucket();
  const object = bucket.file(path);

  try {
    if (input.file) {
      const file = input.file;
      if (!isReceiptFile(file)) {
        return { ok: false, reason: "invalid" };
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      await object.save(buffer, {
        contentType: file.type,
        resumable: false,
      });
    } else {
      // Verify what the signed URL actually wrote before binding it.
      const [metadata] = await object.getMetadata();
      const size = Number(metadata.size ?? 0);
      const type = String(metadata.contentType ?? "");
      const valid =
        size > 0 &&
        size <= RECEIPT_MAX_BYTES &&
        RECEIPT_CONTENT_TYPES.some(
          (t) => type === t || type.startsWith(t),
        );
      if (!valid) {
        // Not a receipt — drop it so it never reaches staff review.
        await object.delete().catch(() => undefined);
        return { ok: false, reason: "invalid" };
      }
    }

    const attach = await attachReceiptToSubmission(input.submissionId);
    if (!attach.ok) return { ok: false, reason: "invalid" };
    return { ok: true };
  } catch (error) {
    logError("receipt", "finalize", error);
    return { ok: false, reason: "error" };
  }
}
