// Browser-side Sentry initialization. Next.js 15.3+/16 loads this file
// before any client code (the instrumentation-client convention).
//
// Absent NEXT_PUBLIC_SENTRY_DSN the SDK is never initialized, so local
// development and CI send nothing to Sentry by default.
import * as Sentry from "@sentry/nextjs";
import {
  getSentryDsn,
  getSentryEnvironment,
  sentryBeforeBreadcrumb,
  sentryBeforeSend,
  sentryBeforeSendTransaction,
} from "@/lib/sentry";

const dsn = getSentryDsn();

if (dsn) {
  Sentry.init({
    dsn,
    environment: getSentryEnvironment(),

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
