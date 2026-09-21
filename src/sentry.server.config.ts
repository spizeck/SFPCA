// Server-side Sentry initialization, loaded via register() in
// instrumentation.ts for the Node.js runtime. This app executes no
// edge-runtime code — proxy.ts (Next.js 16) runs on Node.js — so there
// is deliberately no sentry.edge.config.ts.
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

    // Error monitoring only — no performance tracing, no profiling,
    // no Sentry Logs.
    tracesSampleRate: 0,
    enableLogs: false,

    // Drop the Node integrations whose captured payloads cannot be
    // bounded at source: LocalVariables copies in-scope function
    // variables (request objects, form data) into stack frames, and
    // Http/Https raw request bodies are never needed. Event-level
    // stripping in beforeSend remains as the second layer.
    integrations: (integrations) =>
      integrations.filter(
        (integration) => integration.name !== "LocalVariables",
      ),

    // Privacy boundary — see src/lib/sentry.ts.
    beforeSend: sentryBeforeSend,
    beforeBreadcrumb: sentryBeforeBreadcrumb,
    beforeSendTransaction: sentryBeforeSendTransaction,
  });
}
