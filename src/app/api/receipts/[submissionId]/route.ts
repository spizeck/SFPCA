import "server-only";

// Public receipt upload — the single byte-acceptance boundary for
// receipts/ objects (#219 review). Replaces the earlier signed-URL +
// Server Action fallback pair: a V4 signed PUT cannot enforce a
// maximum size or content type (those need POST-policy conditions GCS
// does not support on PUT), and a Server Action caps bodies at the
// default 1 MB — below the advertised 5 MB receipt limit.
//
// Order of operations is the security contract:
//   1. submission id format — malformed ids die before any work;
//   2. receipt.finalize rate limit — counted BEFORE bytes are read, so
//      there is no "skip finalization" path around the limiter;
//   3. claimReceiptSlot — the atomic, one-time entitlement. The row
//      must exist, be pending, have declared receiptRequested at
//      intake, and hold no receipt. The conditional UPDATE is the
//      concurrency guard: two simultaneous uploads can never both
//      claim — the loser gets 409 before a byte is read;
//   4. bounded stream read — the byte ceiling is enforced on the wire,
//      not on the declared Content-Length;
//   5. magic-byte type validation — detected type is stored, the
//      declared header is only allowed to agree;
//   6. create-only storage write (ifGenerationMatch: 0) — belt on top
//      of the claim's suspenders; storage can never overwrite.
//   Any post-claim failure releases the claim so a legitimate retry
//   can proceed; a claim orphaned by process death is cleared by the
//   daily sweeper once it ages past the grace window.
//
// The submission id doubles as the bearer capability: it is a
// client-generated uuidv4 disclosed only to the submitter, and the row
// it names must still satisfy the claim predicates above.

import { NextResponse } from "next/server";
import {
  claimReceiptSlot,
  releaseReceiptSlot,
} from "@/lib/registry/registrations";
import { checkRateLimit, warnThrottled } from "@/lib/rate-limit";
import { publicIntakeSubject } from "@/lib/request-identity";
import { adminReceiptBucket } from "@/lib/firebase-admin-storage";
import {
  detectReceiptContentType,
  readBoundedBody,
} from "@/lib/receipt-upload";
import { RECEIPT_MAX_BYTES } from "@/lib/animal-registration";
import { logError } from "@/lib/logger";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ submissionId: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const { submissionId } = await context.params;
  if (!UUID_RE.test(submissionId)) {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  const gate = await checkRateLimit(
    "receipt.finalize",
    await publicIntakeSubject(),
  );
  if (!gate.allowed) {
    warnThrottled("receipt", "receipt.finalize", gate);
    return NextResponse.json(
      { ok: false, reason: "throttled" },
      { status: 429 },
    );
  }

  // Authorize before accepting bytes: the claim is the entitlement.
  const claim = await claimReceiptSlot(submissionId);
  if (!claim.ok) {
    return NextResponse.json(
      { ok: false, reason: claim.reason },
      { status: claim.reason === "not-found" ? 404 : 409 },
    );
  }

  const fail = async (status: number, reason: string) => {
    await releaseReceiptSlot(submissionId).catch((error) =>
      logError("receipt", "release-claim", error),
    );
    return NextResponse.json({ ok: false, reason }, { status });
  };

  // Everything past the claim runs under a release guarantee: a thrown
  // read (client aborts mid-upload) or a failed write must free the
  // slot immediately, not leave it for the daily sweeper to clear past
  // the grace window — a stuck claim turns every legit retry into 409.
  try {
    const body = await readBoundedBody(request, RECEIPT_MAX_BYTES);
    if (!body.ok) {
      return await fail(
        body.reason === "too-large" ? 413 : 400,
        body.reason!,
      );
    }

    const contentType = detectReceiptContentType(
      body.buffer!,
      request.headers.get("content-type"),
    );
    if (!contentType) {
      return await fail(415, "unsupported-media");
    }

    await adminReceiptBucket()
      .file(`receipts/${submissionId}`)
      .save(body.buffer!, {
        contentType,
        resumable: false,
        // Create-only at the storage layer: even if two claims somehow
        // raced past Postgres, GCS refuses to overwrite a live object.
        preconditionOpts: { ifGenerationMatch: 0 },
      });
  } catch (error) {
    logError("receipt", "upload-write", error);
    return fail(500, "error");
  }

  return NextResponse.json({ ok: true });
}
