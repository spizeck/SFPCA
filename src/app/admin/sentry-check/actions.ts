"use server";

import { requireAdmin } from "@/lib/auth";
import { sentryVerificationError } from "@/lib/sentry-verification";

// Server-side verification: throws a synthetic error that propagates
// through the real production path — Next.js surfaces it via
// instrumentation.ts `onRequestError` → Sentry, and the Vercel runtime
// log carries the matching digest.
//
// Server actions are POST endpoints reachable without rendering the
// admin page, so the action verifies the session itself rather than
// relying on AdminLayout. Anonymous/non-admin calls return quietly —
// no throw, no Sentry event, nothing revealed beyond "not fired".
export async function fireSentryVerification(): Promise<{
  fired: boolean;
}> {
  const { authorized } = await requireAdmin();
  if (!authorized) {
    return { fired: false };
  }
  throw sentryVerificationError("server");
}
