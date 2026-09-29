// Next.js instrumentation hook. Registers the Node.js server SDK and
// exports onRequestError so unexpected errors in Server Components,
// route handlers, Server Actions, and proxy.ts are captured by Sentry.
//
// There is no edge-runtime branch: proxy.ts executes on the Node.js
// runtime (Next.js 16 proxy always runs on Node), and no route or
// component opts into the edge runtime — adding an edge config would
// instrument a runtime this app never uses.
import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { after } from "next/server";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

// Bound for the post-response flush below — long enough for a cold
// function's first envelope, short enough to never matter to a visitor.
const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

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
// second SDK flush to the request lifecycle — Next/Vercel keeps the
// function alive until after-tasks finish, making delivery
// deterministic. Where no request scope exists (after throws outside a
// request) the previous floating-flush behavior is the fallback.
export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  Sentry.captureRequestError(error, request, context);
  const flush = () =>
    Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS).catch(() => false);
  try {
    after(flush);
  } catch {
    void flush();
  }
};
