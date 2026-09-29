// Next.js instrumentation hook. Registers the Node.js server SDK and
// exports onRequestError so unexpected errors in Server Components,
// route handlers, Server Actions, and proxy.ts are captured by Sentry.
//
// There is no edge-runtime branch: proxy.ts executes on the Node.js
// runtime (Next.js 16 proxy always runs on Node), and no route or
// component opts into the edge runtime — adding an edge config would
// instrument a runtime this app never uses.
import * as Sentry from "@sentry/nextjs";
import { getDeadline } from "@vercel/functions";
import type { Instrumentation } from "next";
import { after } from "next/server";
import { logWarn } from "@/lib/logger";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

// A wedged ingest endpoint will not recover past this point — the cap
// keeps a pathological flush from holding the function instance open
// for the entire configured maxDuration.
const SENTRY_FLUSH_MAX_MS = 30_000;
// Reserve time after a failed flush for the failure log line to reach
// Vercel's runtime logs before the platform terminates the invocation.
const SENTRY_FLUSH_DEADLINE_MARGIN_MS = 2_000;
// No invocation deadline exists off Vercel (self-hosted next start) —
// the waitUntil-style binding is absent there anyway, so keep it short.
const SENTRY_FLUSH_FALLBACK_MS = 5_000;

// onRequestError does fire for uncaught Server Action errors on this
// app's Next.js version (verified in production mode: the hook receives
// the original error and digest with routeType 'action'). What lost the
// SENTRY_VERIFICATION_EVENT:server event on Vercel was the delivery
// step: Sentry.captureRequestError registers its SDK flush through
// vercelWaitUntil, which only attaches to the request lifecycle on the
// Edge runtime — on Node.js it is a no-op, so the envelope send floats
// and can be abandoned when the function freezes after the error
// response.
//
// captureRequestError still performs the capture; after() then binds a
// second SDK flush to the request lifecycle. The flush timeout is not a
// guess: getDeadline() returns the invocation deadline Vercel computed
// from the function's maxDuration — the same budget waitUntil/after()
// tasks share. It is read here in request scope because Vercel's
// request-context store is reliably populated now, not inside the
// deferred task. The flush waits up to (deadline − margin), capped, so
// delivery gets the platform's real post-response budget instead of an
// arbitrary constant. A flush that still fails is logged to the
// runtime logs rather than silently dropped. Where no request scope
// exists (after throws) the previous floating-flush behavior is the
// fallback.
export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  Sentry.captureRequestError(error, request, context);
  const deadline = getDeadline();
  const flush = () => flushSentryDeliveries(deadline);
  try {
    after(flush);
  } catch {
    void flush();
  }
};

async function flushSentryDeliveries(deadline: Date | undefined) {
  // Local dev, CI, and E2E never initialize the SDK (#235) — nothing is
  // queued, so there is nothing to flush and nothing to warn about.
  if (!Sentry.getClient()) return;
  const timeout = deadline
    ? Math.min(
        SENTRY_FLUSH_MAX_MS,
        Math.max(
          0,
          deadline.getTime() - Date.now() - SENTRY_FLUSH_DEADLINE_MARGIN_MS,
        ),
      )
    : SENTRY_FLUSH_FALLBACK_MS;
  const delivered = await Sentry.flush(timeout).catch(() => false);
  if (!delivered) {
    // Console-only warn (never Sentry — that transport is exactly what
    // just failed): the uncaught error was captured but its envelope may
    // not have reached Sentry before the invocation froze.
    logWarn(
      "sentry",
      "flush-uncaught-server-error",
      "Sentry event may not have been delivered before the invocation ended",
      { flushTimeoutMs: timeout },
    );
  }
}
