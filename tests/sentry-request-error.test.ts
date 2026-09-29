// The uncaught server path of /admin/sentry-check: an admin server
// action throws, Next.js invokes instrumentation.ts onRequestError
// (verified in production mode on this app's Next version — the hook
// receives the original error + digest with routeType 'action'), and
// the hook forwards to Sentry.captureRequestError while binding the
// SDK flush to the request lifecycle via after().
//
// The lifecycle binding is the fix: captureRequestError's internal
// flush registers through Sentry's vercelWaitUntil, which only wires
// waitUntil on the Edge runtime — on this app's Node.js runtime it
// no-ops, so the envelope send floats and can be abandoned when a
// serverless function freezes after the error response. That delivery
// gap is what kept SENTRY_VERIFICATION_EVENT:server out of Sentry.
// The flush timeout comes from @vercel/functions getDeadline() — the
// real invocation budget — and a failed flush is logged so a dropped
// event is observable. The SDK and platform hooks are mocked; nothing
// here can contact sentry.io.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";

const { captureRequestError, flush, getClient, getDeadline, after, logWarn } =
  vi.hoisted(() => ({
    captureRequestError: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
    getClient: vi.fn().mockReturnValue({}),
    getDeadline: vi.fn(),
    after: vi.fn(),
    logWarn: vi.fn(),
  }));

vi.mock("@sentry/nextjs", () => ({ captureRequestError, flush, getClient }));
vi.mock("@vercel/functions", () => ({ getDeadline }));
vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/logger", () => ({ logWarn }));

import { onRequestError } from "@/instrumentation";
import { sentryBeforeSend } from "@/lib/sentry";
import {
  SENTRY_VERIFICATION_MARKER,
  sentryVerificationError,
} from "@/lib/sentry-verification";

const request = {
  path: "/admin/sentry-check",
  method: "POST",
  headers: { host: "sabafpca.com" },
};

// The exact context Next.js produced for a fetch Server Action POST in
// the production-mode reproduction.
const actionContext = {
  routerKind: "App Router" as const,
  routePath: "/admin/sentry-check",
  routeType: "action" as const,
  renderSource: "react-server-components-payload" as const,
  revalidateReason: undefined,
};

const runAfterTask = async () => {
  expect(after).toHaveBeenCalledTimes(1);
  const task = after.mock.calls[0][0] as () => Promise<unknown>;
  await task();
};

beforeEach(() => {
  getClient.mockReturnValue({});
  getDeadline.mockReturnValue(undefined);
  flush.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("onRequestError", () => {
  test("forwards the :server verification error to captureRequestError exactly once", () => {
    const error = sentryVerificationError("server");

    onRequestError(error, request, actionContext);

    expect(captureRequestError).toHaveBeenCalledTimes(1);
    const [captured, req, ctx] = captureRequestError.mock.calls[0];
    expect((captured as Error).message).toContain(
      `${SENTRY_VERIFICATION_MARKER}:server`,
    );
    expect(req).toBe(request);
    expect(ctx).toBe(actionContext);
  });

  test("forwards a representative non-verification uncaught error", () => {
    const error = Object.assign(new Error("database connection lost"), {
      digest: "deadbeef",
    });

    onRequestError(error, request, actionContext);

    expect(captureRequestError).toHaveBeenCalledTimes(1);
    expect(captureRequestError.mock.calls[0][0]).toBe(error);
  });

  test("binds the SDK flush to the post-response lifecycle via after()", async () => {
    onRequestError(new Error("uncaught"), request, actionContext);

    // No flush inline — the task runs after the response, where
    // Next/Vercel keeps the function alive until it resolves.
    expect(flush).not.toHaveBeenCalled();
    await runAfterTask();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test("sizes the flush timeout to the invocation deadline (capped)", async () => {
    // 60s of invocation budget left → the 30s cap applies.
    getDeadline.mockReturnValue(new Date(Date.now() + 60_000));

    onRequestError(new Error("uncaught"), request, actionContext);
    await runAfterTask();

    expect(flush).toHaveBeenCalledWith(30_000);
  });

  test("leaves margin for the failure log when the deadline is near", async () => {
    // 10s of budget left → timeout must leave the 2s margin.
    getDeadline.mockReturnValue(new Date(Date.now() + 10_000));

    onRequestError(new Error("uncaught"), request, actionContext);
    await runAfterTask();

    const timeout = flush.mock.calls[0][0] as number;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(8_000);
  });

  test("does not wait at all when the invocation deadline has passed", async () => {
    getDeadline.mockReturnValue(new Date(Date.now() - 500));

    onRequestError(new Error("uncaught"), request, actionContext);
    await runAfterTask();

    expect(flush).toHaveBeenCalledWith(0);
  });

  test("uses a short fallback off Vercel (no invocation deadline)", async () => {
    getDeadline.mockReturnValue(undefined);

    onRequestError(new Error("uncaught"), request, actionContext);
    await runAfterTask();

    expect(flush).toHaveBeenCalledWith(5_000);
  });

  test("a failed flush is observable in runtime logs, not silent", async () => {
    flush.mockResolvedValue(false);

    onRequestError(new Error("uncaught"), request, actionContext);
    await runAfterTask();

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][0]).toBe("sentry");
    expect(logWarn.mock.calls[0][1]).toBe("flush-uncaught-server-error");
  });

  test("a successful flush logs nothing", async () => {
    onRequestError(new Error("uncaught"), request, actionContext);
    await runAfterTask();

    expect(logWarn).not.toHaveBeenCalled();
  });

  test("skips the flush entirely when the SDK was never initialized", async () => {
    // Local dev, CI, and E2E never call Sentry.init (#235) — nothing is
    // queued, so there must be no flush attempt and no spurious warn.
    getClient.mockReturnValue(undefined);

    onRequestError(new Error("uncaught"), request, actionContext);
    await runAfterTask();

    expect(flush).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  test("falls back to a floating flush when no request scope exists", async () => {
    after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    onRequestError(new Error("uncaught"), request, actionContext);
    // The fallback task is fire-and-forget — give it a tick to run.
    await Promise.resolve();

    expect(captureRequestError).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe("beforeSend on the :server capture shape", () => {
  test("the synthetic action exception is not classified as expected or dropped", () => {
    const error = sentryVerificationError("server");
    // The event shape Sentry.captureRequestError produces: mechanism
    // auto.function.nextjs.on_request_error (handled:false), the nextjs
    // context block, and request metadata — run through the same
    // privacy boundary every server event crosses.
    const event = {
      type: undefined,
      event_id: "evt-server",
      platform: "node",
      exception: {
        values: [{ type: "Error", value: error.message }],
      },
      request: {
        method: "POST",
        headers: { host: "sabafpca.com" },
      },
      contexts: {
        nextjs: {
          request_path: "/admin/sentry-check",
          router_kind: "App Router",
          router_path: "/admin/sentry-check",
          route_type: "action",
        },
      },
      transaction: "POST /admin/sentry-check",
      tags: { "nextjs.error_digest": "1407644785" },
    } as unknown as ErrorEvent;

    const out = sentryBeforeSend(event, { originalException: error });

    expect(out).not.toBeNull();
    expect(out!.exception!.values![0].value).toContain(
      `${SENTRY_VERIFICATION_MARKER}:server`,
    );
    expect(out!.request).toEqual({ method: "POST" });
    expect(out!.contexts!.nextjs).toMatchObject({ route_type: "action" });
  });
});
