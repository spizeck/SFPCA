// Next.js instrumentation hook. Registers the Node.js server SDK and
// exports onRequestError so unexpected errors in Server Components,
// route handlers, and proxy.ts are captured by Sentry.
//
// There is no edge-runtime branch: proxy.ts executes on the Node.js
// runtime (Next.js 16 proxy always runs on Node), and no route or
// component opts into the edge runtime — adding an edge config would
// instrument a runtime this app never uses.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
