// Tests for our Sentry configuration — not the SDK itself. The SDK is
// mocked throughout; nothing here can contact sentry.io.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

const { captureException, init, captureRequestError } = vi.hoisted(() => ({
  captureException: vi.fn(),
  init: vi.fn(),
  captureRequestError: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  init,
  captureException,
  captureRequestError,
  captureRouterTransitionStart: vi.fn(),
  breadcrumbsIntegration: (opts: unknown) => ({
    name: "Breadcrumbs",
    options: opts,
  }),
}));

import {
  getSentryDsn,
  getSentryEnvironment,
  sentryBeforeBreadcrumb,
  sentryBeforeSend,
  sentryBeforeSendTransaction,
} from "@/lib/sentry";
import { ErrorFallback } from "@/components/error-fallback";

afterEach(() => {
  vi.clearAllMocks();
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

  test("environment prefers explicit override, then deploy context", () => {
    expect(getSentryEnvironment({})).toBe("development");
    expect(getSentryEnvironment({ NODE_ENV: "production" })).toBe("production");
    expect(
      getSentryEnvironment({ VERCEL_ENV: "preview", NODE_ENV: "production" }),
    ).toBe("preview");
    expect(
      getSentryEnvironment({
        NEXT_PUBLIC_SENTRY_ENVIRONMENT: "staging",
        VERCEL_ENV: "preview",
      }),
    ).toBe("staging");
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
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    await import("@/instrumentation-client");
    expect(init).not.toHaveBeenCalled();
  });

  test("server init is skipped entirely without a DSN", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    await import("@/sentry.server.config");
    expect(init).not.toHaveBeenCalled();
  });

  test("client init applies the privacy boundary when a DSN exists", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://k@o1.ingest.sentry.io/2";
    await import("@/instrumentation-client");
    expect(init).toHaveBeenCalledTimes(1);
    const opts = init.mock.calls[0][0];
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.enableLogs).toBe(false);
    expect(opts.dsn).toBe("https://k@o1.ingest.sentry.io/2");
    // Compare against the freshly-imported module — resetModules gives
    // this import a new instance.
    const fresh = await import("@/lib/sentry");
    expect(opts.beforeSend).toBe(fresh.sentryBeforeSend);
    expect(opts.beforeSendTransaction).toBe(fresh.sentryBeforeSendTransaction);
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  });

  test("register() loads the server config on the Node runtime and re-exports onRequestError", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://k@o1.ingest.sentry.io/2";
    process.env.NEXT_RUNTIME = "nodejs";
    const instrumentation = await import("@/instrumentation");
    await instrumentation.register();
    expect(init).toHaveBeenCalledTimes(1);
    expect(instrumentation.onRequestError).toBe(captureRequestError);
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.NEXT_RUNTIME;
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
