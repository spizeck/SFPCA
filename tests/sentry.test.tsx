// Tests for our Sentry configuration — not the SDK itself. The SDK is
// mocked throughout; nothing here can contact sentry.io.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

const { captureException, init, captureRequestError, flush, getClient } =
  vi.hoisted(() => ({
    captureException: vi.fn(),
    init: vi.fn(),
    captureRequestError: vi.fn(),
    captureRouterTransitionStart: vi.fn(),
    flush: vi.fn().mockResolvedValue(false),
    getClient: vi.fn().mockReturnValue({}),
  }));

vi.mock("@sentry/nextjs", () => ({
  init,
  captureException,
  captureRequestError,
  captureRouterTransitionStart: vi.fn(),
  flush,
  getClient,
  breadcrumbsIntegration: (opts: unknown) => ({
    name: "Breadcrumbs",
    options: opts,
  }),
}));

import {
  getSentryDsn,
  resolveSentryEnvironment,
  resolveSentryRuntime,
  sentryBeforeBreadcrumb,
  sentryBeforeSend,
  sentryBeforeSendTransaction,
} from "@/lib/sentry";
import { ErrorFallback } from "@/components/error-fallback";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const baseEvent = (): ErrorEvent => ({
  type: undefined,
  event_id: "evt-1",
  platform: "javascript",
  message: "plain failure",
  tags: { subsystem: "ui" },
});

describe("environment resolution", () => {
  test("absent DSN resolves to undefined — SDK is never initialized", () => {
    expect(getSentryDsn({})).toBeUndefined();
    expect(getSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "" })).toBeUndefined();
    expect(getSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2" }))
      .toBe("https://k@o1.ingest.sentry.io/2");
  });

  // Real Vercel deployments: VERCEL_DEPLOYMENT_ID exists at build and
  // runtime, VERCEL_REGION at runtime — `vercel env pull` never emits
  // either, so they are the proof of deployment context (#235).
  test("Vercel production deployment resolves production and sends", () => {
    const env = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      VERCEL_DEPLOYMENT_ID: "dpl_abc",
      VERCEL_ENV: "production",
      VERCEL: "1",
      NODE_ENV: "production",
    };
    expect(resolveSentryEnvironment(env)).toBe("production");
    expect(resolveSentryRuntime(env)).toMatchObject({
      environment: "production",
      sendEvents: true,
    });
  });

  test("Vercel preview deployment resolves preview and sends", () => {
    const env = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      VERCEL_DEPLOYMENT_ID: "dpl_abc",
      VERCEL_ENV: "preview",
      NODE_ENV: "production",
    };
    expect(resolveSentryEnvironment(env)).toBe("preview");
    expect(resolveSentryRuntime(env).sendEvents).toBe(true);
  });

  test("VERCEL_REGION alone proves a Vercel runtime", () => {
    expect(
      resolveSentryEnvironment({
        VERCEL_REGION: "iad1",
        VERCEL_ENV: "production",
      }),
    ).toBe("production");
  });

  // The observed bug: `vercel env pull` writes the production project
  // environment into .env.local. VERCEL_ENV / NEXT_PUBLIC_SENTRY_ENVIRONMENT
  // then claim "production" for a process that is not on Vercel at all.
  test("a pulled production .env.local can never classify as production", () => {
    const pulledEnv = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_TARGET_ENV: "production",
      VERCEL_URL: "saba-sfpca.vercel.app",
      NODE_ENV: "development",
    };
    expect(resolveSentryEnvironment(pulledEnv)).toBe("development");
    expect(resolveSentryRuntime(pulledEnv).sendEvents).toBe(false);
    // Same pulled env under `next build`/`next start` (NODE_ENV becomes
    // production) still cannot claim production.
    expect(
      resolveSentryEnvironment({ ...pulledEnv, NODE_ENV: "production" }),
    ).toBe("development");
    expect(
      resolveSentryRuntime({ ...pulledEnv, NODE_ENV: "production" })
        .sendEvents,
    ).toBe(false);
  });

  test("plain local development resolves development and does not send", () => {
    const env = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      NODE_ENV: "development",
    };
    expect(resolveSentryEnvironment(env)).toBe("development");
    expect(resolveSentryRuntime(env).sendEvents).toBe(false);
  });

  test("Playwright E2E / emulator runs resolve test and do not send", () => {
    const webServerEnv = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      NEXT_PUBLIC_USE_FIREBASE_EMULATOR: "true",
      NODE_ENV: "development",
    };
    expect(resolveSentryEnvironment(webServerEnv)).toBe("test");
    expect(resolveSentryRuntime(webServerEnv).sendEvents).toBe(false);
    // Emulator host vars exported by `firebase emulators:exec` classify
    // the same way even without the Playwright flag.
    expect(
      resolveSentryEnvironment({
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      }),
    ).toBe("test");
  });

  test("CI without deployment context resolves test, never production", () => {
    const env = {
      CI: "true",
      NODE_ENV: "production",
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
    };
    expect(resolveSentryEnvironment(env)).toBe("test");
    expect(resolveSentryRuntime(env).sendEvents).toBe(false);
    // Even when CI somehow carries a pulled production VERCEL_ENV.
    expect(
      resolveSentryEnvironment({ ...env, VERCEL_ENV: "production" }),
    ).toBe("test");
  });

  test("a release SHA never influences environment classification", () => {
    const env = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      SENTRY_RELEASE: "dfe314e",
      VERCEL_GIT_COMMIT_SHA: "dfe314e",
      NODE_ENV: "production",
    };
    expect(resolveSentryEnvironment(env)).not.toBe("production");
    expect(resolveSentryRuntime(env).sendEvents).toBe(false);
  });

  test("SENTRY_ENABLE_LOCAL opts a local run into sending under its resolved label", () => {
    const env = {
      NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      SENTRY_ENABLE_LOCAL: "true",
      NODE_ENV: "development",
    };
    expect(resolveSentryRuntime(env)).toMatchObject({
      environment: "development",
      sendEvents: true,
    });
    // Opted-in test runs still cannot claim production.
    expect(
      resolveSentryRuntime({
        ...env,
        NEXT_PUBLIC_USE_FIREBASE_EMULATOR: "true",
      }),
    ).toMatchObject({ environment: "test", sendEvents: true });
  });

  test("non-production override labels work off-Vercel; production is unreachable", () => {
    expect(
      resolveSentryEnvironment({
        NEXT_PUBLIC_SENTRY_ENVIRONMENT: "chad-local",
      }),
    ).toBe("chad-local");
    expect(
      resolveSentryEnvironment({ NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production" }),
    ).not.toBe("production");
  });

  test("on Vercel the override cannot outrank VERCEL_ENV", () => {
    // A Production-scoped override value leaking into a Preview deploy
    // must not relabel it — VERCEL_ENV is authoritative on real infra.
    expect(
      resolveSentryEnvironment({
        VERCEL_DEPLOYMENT_ID: "dpl_abc",
        VERCEL_ENV: "preview",
        NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
      }),
    ).toBe("preview");
  });

  test("no DSN means no sending in any context", () => {
    expect(
      resolveSentryRuntime({
        VERCEL_DEPLOYMENT_ID: "dpl_abc",
        VERCEL_ENV: "production",
      }).sendEvents,
    ).toBe(false);
    expect(
      resolveSentryRuntime({ SENTRY_ENABLE_LOCAL: "true" }).sendEvents,
    ).toBe(false);
  });
});

describe("sentryBeforeSend", () => {
  test("drops expected auth rejections — they are not incidents", () => {
    const err = Object.assign(new Error("expired"), {
      code: "auth/id-token-expired",
    });
    expect(sentryBeforeSend(baseEvent(), { originalException: err })).toBeNull();
    expect(
      sentryBeforeSend(baseEvent(), {
        originalException: Object.assign(new Error("x"), {
          code: "auth/argument-error",
        }),
      }),
    ).toBeNull();
    // Real failures still report.
    const boom = new Error("boom");
    expect(
      sentryBeforeSend(baseEvent(), { originalException: boom }),
    ).not.toBeNull();
  });

  test("drops 'Unauthorized' action denials — an expected outcome, not an incident", () => {
    // Server actions/loaders signal denial with the plain literal
    // throw new Error("Unauthorized"); reaching onRequestError they
    // would otherwise page on every expired session or probe.
    expect(
      sentryBeforeSend(baseEvent(), {
        originalException: new Error("Unauthorized"),
      }),
    ).toBeNull();
    // Near-misses are untouched — only the exact denial literal drops.
    for (const message of [
      "Unauthorized: missing role",
      "unauthorized",
      "Request failed with status 401 Unauthorized",
    ]) {
      expect(
        sentryBeforeSend(baseEvent(), {
          originalException: new Error(message),
        }),
      ).not.toBeNull();
    }
  });

  test("strips request headers, cookies, body, and query string", () => {
    const event = {
      ...baseEvent(),
      request: {
        method: "POST",
        url: "https://www.sabafpca.com/api/auth/session?token=abc&x=1#frag",
        query_string: "token=abc&x=1",
        headers: {
          authorization: "Bearer secret-token",
          cookie: "session=abc123",
          "content-type": "application/json",
        },
        cookies: { session: "abc123" },
        data: { idToken: "eyJ...", ownerName: "Jane Doe" },
        env: { FIREBASE_ADMIN_PRIVATE_KEY: "key" },
      },
    } as unknown as ErrorEvent;
    const out = sentryBeforeSend(event, {});
    expect(out).not.toBeNull();
    expect(out!.request).toEqual({
      method: "POST",
      url: "https://www.sabafpca.com/api/auth/session",
    });
    expect(out!.request).not.toHaveProperty("headers");
    expect(out!.request).not.toHaveProperty("cookies");
    expect(out!.request).not.toHaveProperty("data");
    expect(out!.request).not.toHaveProperty("query_string");
    expect(out!.request).not.toHaveProperty("env");
  });

  test("never transmits user identity or server hostname", () => {
    const event = {
      ...baseEvent(),
      user: { id: "u1", email: "owner@example.com", ip_address: "1.2.3.4" },
      server_name: "prod-vercel-1",
    } as ErrorEvent;
    const out = sentryBeforeSend(event, {});
    expect(out).not.toHaveProperty("user");
    expect(out).not.toHaveProperty("server_name");
  });

  test("redacts emails, receipt paths, and bearer tokens in messages", () => {
    const event = {
      ...baseEvent(),
      message: "upload failed for receipts/reg-99 by jane@example.com",
      exception: {
        values: [
          {
            type: "Error",
            value:
              "Bearer eyJhbGci used receipts/reg-1 for owner jane.doe@example.com",
            stacktrace: {
              frames: [
                {
                  filename: "app:///_next/chunk.js",
                  function: "handleSubmit",
                  vars: { formData: { ownerName: "Jane Doe" } },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;
    const out = sentryBeforeSend(event, {});
    const value = out!.exception!.values![0];
    expect(value.value).not.toContain("jane.doe@example.com");
    expect(value.value).not.toContain("eyJhbGci");
    expect(value.value).not.toContain("reg-1");
    expect(value.value).toContain("receipts/[redacted]");
    expect(out!.message).toContain("[redacted-email]");
    expect(out!.message).toContain("receipts/[redacted]");
    // Local variables captured at throw time never leave the process.
    expect(value.stacktrace!.frames![0]).not.toHaveProperty("vars");
  });

  test("removes console/ui breadcrumbs and scrubs navigation URLs", () => {
    const event = {
      ...baseEvent(),
      breadcrumbs: [
        { category: "console", message: "payload jane@example.com" },
        { category: "ui.click", message: "click" },
        { category: "ui.input", message: "typing" },
        {
          category: "navigation",
          data: {
            from: "/login?next=/admin",
            to: "/admin/registrations?receipt=abc",
            session: "should-be-dropped",
          },
        },
        {
          category: "fetch",
          data: { url: "/api/auth/session?token=xyz", method: "POST" },
          message: "POST api jane@example.com",
        },
      ] as Breadcrumb[],
    } as unknown as ErrorEvent;
    const out = sentryBeforeSend(event, {});
    const crumbs = out!.breadcrumbs!;
    expect(crumbs).toHaveLength(2);
    const nav = crumbs[0];
    expect(nav.data!.from).toBe("/login");
    expect(nav.data!.to).toBe("/admin/registrations");
    expect(nav.data).not.toHaveProperty("session");
    const fetchCrumb = crumbs[1];
    expect(fetchCrumb.data!.url).toBe("/api/auth/session");
    expect(fetchCrumb.message).toContain("[redacted-email]");
  });

  test("drops sensitive-named extra/context keys, keeps safe context", () => {
    const event = {
      ...baseEvent(),
      tags: { subsystem: "ui", ownerEmail: "jane@example.com" },
      extra: {
        componentStack: "at RegistrationForm",
        paymentReceipt: "receipts/reg-1",
        idToken: "eyJ...",
      },
      contexts: {
        runtime: { name: "node", version: "24" },
        request: { headers: { cookie: "session=x" } },
      },
      fingerprint: ["group-1"],
    } as unknown as ErrorEvent;
    const out = sentryBeforeSend(event, {});
    expect(out!.extra).toMatchObject({ componentStack: "at RegistrationForm" });
    expect(out!.extra).not.toHaveProperty("paymentReceipt");
    expect(out!.extra).not.toHaveProperty("idToken");
    expect(out!.tags).toMatchObject({ subsystem: "ui" });
    expect(out!.tags).not.toHaveProperty("ownerEmail");
    expect(out!.contexts!.runtime).toEqual({ name: "node", version: "24" });
    expect(out!.contexts!.request).not.toHaveProperty("headers");
    expect(out!.fingerprint).toEqual(["group-1"]);
  });
});

describe("sentryBeforeBreadcrumb", () => {
  test("drops console and UI-interaction crumbs", () => {
    expect(
      sentryBeforeBreadcrumb({ category: "console", message: "x" }),
    ).toBeNull();
    expect(
      sentryBeforeBreadcrumb({ category: "ui.input", message: "x" }),
    ).toBeNull();
    expect(
      sentryBeforeBreadcrumb({ category: "ui.click", message: "x" }),
    ).toBeNull();
  });

  test("keeps navigation crumbs minus query strings", () => {
    const crumb = sentryBeforeBreadcrumb({
      category: "navigation",
      data: { to: "/contact?subject=receipts/reg-7" },
    });
    expect(crumb).not.toBeNull();
    expect(crumb!.data!.to).toBe("/contact");
  });
});

describe("sentryBeforeSendTransaction", () => {
  test("transactions, spans, and profiles are never emitted", () => {
    expect(
      sentryBeforeSendTransaction({ type: "transaction" } as never, {} as never),
    ).toBeNull();
  });
});

describe("SDK initialization gating", () => {
  test("client init is skipped entirely without a DSN", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_SEND_EVENTS", "true");
    await import("@/instrumentation-client");
    expect(init).not.toHaveBeenCalled();
  });

  test("client init is skipped when the build resolved sending off", async () => {
    // A DSN alone is not enough — local/E2E builds inject
    // NEXT_PUBLIC_SENTRY_SEND_EVENTS="false" (#235).
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://k@o1.ingest.sentry.io/2");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_SEND_EVENTS", "false");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT", "development");
    await import("@/instrumentation-client");
    expect(init).not.toHaveBeenCalled();
  });

  test("server init is skipped entirely without a DSN", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_abc");
    vi.stubEnv("VERCEL_ENV", "production");
    await import("@/sentry.server.config");
    expect(init).not.toHaveBeenCalled();
  });

  test("server init is skipped for a local run carrying a pulled production env", async () => {
    // Regression for #235: DSN + VERCEL_ENV=production present (the
    // `vercel env pull` shape) but no Vercel deployment markers — the
    // SDK must not initialize at all.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://k@o1.ingest.sentry.io/2");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    await import("@/sentry.server.config");
    expect(init).not.toHaveBeenCalled();
  });

  test("client init applies the privacy boundary when sending is enabled", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://k@o1.ingest.sentry.io/2");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_SEND_EVENTS", "true");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT", "production");
    await import("@/instrumentation-client");
    expect(init).toHaveBeenCalledTimes(1);
    const opts = init.mock.calls[0][0];
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.enableLogs).toBe(false);
    expect(opts.dsn).toBe("https://k@o1.ingest.sentry.io/2");
    expect(opts.environment).toBe("production");
    // Compare against the freshly-imported module — resetModules gives
    // this import a new instance.
    const fresh = await import("@/lib/sentry");
    expect(opts.beforeSend).toBe(fresh.sentryBeforeSend);
    expect(opts.beforeSendTransaction).toBe(fresh.sentryBeforeSendTransaction);
  });

  test("register() loads the server config on the Node runtime and onRequestError captures", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://k@o1.ingest.sentry.io/2");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_abc");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const instrumentation = await import("@/instrumentation");
    await instrumentation.register();
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0].environment).toBe("production");
    // The hook forwards the uncaught error to Sentry's captureRequestError
    // and binds the flush to the request lifecycle (or a floating flush
    // outside request scope) so serverless freeze cannot drop the event.
    instrumentation.onRequestError(
      new Error("uncaught"),
      { path: "/admin/sentry-check", method: "POST", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/admin/sentry-check",
        routeType: "action",
        renderSource: "react-server-components-payload",
        revalidateReason: undefined,
      },
    );
    expect(captureRequestError).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalled();
  });
});

describe("ErrorFallback capture", () => {
  test("renders the existing fallback and captures once with digest tag", () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = Object.assign(new Error("render exploded"), {
      digest: "digest-42",
    });
    render(<ErrorFallback error={error} reset={() => {}} />);
    // Existing UX unchanged.
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    // Exactly one capture — the shared fallback is the single site for
    // both boundaries, so a boundary error can never double-report.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { "nextjs.error_digest": "digest-42" },
    });
    // #94 logging is preserved alongside capture.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  test("captures with empty tags when no digest exists", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("no digest");
    render(<ErrorFallback error={error} />);
    expect(captureException).toHaveBeenCalledWith(error, { tags: {} });
  });
});
