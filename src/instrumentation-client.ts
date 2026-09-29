// Browser-side Sentry initialization. Next.js 15.3+/16 loads this file
// before any client code (the instrumentation-client convention).
import * as Sentry from "@sentry/nextjs";
import {
  sentryBeforeBreadcrumb,
  sentryBeforeSend,
  sentryBeforeSendTransaction,
} from "@/lib/sentry";

// The public env values must be direct `process.env.NEXT_PUBLIC_*`
// member expressions: Next.js inlines only statically analyzable
// references into the client bundle at build time. Routing them through
// a helper that reads a passed/defaulted env object compiles to a
// runtime lookup on the browser's empty process shim — the values are
// never inlined, the DSN is undefined, and the SDK never initializes
// (#146). The env-object helpers in lib/sentry.ts are for the server
// and tests only.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

// Environment/sending are RESOLVED at build time by next.config.ts via
// the shared resolveSentryRuntime() (#235) — the browser never reads
// VERCEL_ENV or NEXT_PUBLIC_SENTRY_ENVIRONMENT directly, so a
// `vercel env pull`-generated .env.local cannot make local or E2E
// sessions report as production. When NEXT_PUBLIC_SENTRY_SEND_EVENTS
// is not "true" the init call is dead code (skipped entirely — no SDK
// initialization, no outbound events).
const sendEvents = process.env.NEXT_PUBLIC_SENTRY_SEND_EVENTS === "true";
const environment =
  process.env.NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT || "development";

if (dsn && sendEvents) {
  Sentry.init({
    dsn,
    environment,

    // Never attach user identity, IP, request headers, or cookies.
    sendDefaultPii: false,

    // Error monitoring only — no performance tracing, no Session
    // Replay, no profiling, no user feedback, no Sentry Logs.
    tracesSampleRate: 0,
    enableLogs: false,

    // Keep fetch/xhr/history/navigation breadcrumbs but cut the
    // categories that can capture application payloads or form
    // interactions: console.* text and DOM click/input events.
    integrations: (integrations) =>
      integrations.map((integration) =>
        integration.name === "Breadcrumbs"
          ? Sentry.breadcrumbsIntegration({
              console: false,
              dom: false,
            })
          : integration,
      ),

    // Privacy boundary — see src/lib/sentry.ts.
    beforeSend: sentryBeforeSend,
    beforeBreadcrumb: sentryBeforeBreadcrumb,
    beforeSendTransaction: sentryBeforeSendTransaction,
  });
}

// Required App Router export; no-ops when the SDK is not initialized
// and emits nothing while tracing is disabled.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
