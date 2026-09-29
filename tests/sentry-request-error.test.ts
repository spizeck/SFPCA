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
// The SDK is mocked; nothing here can contact sentry.io.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";

const { captureRequestError, flush, after } = vi.hoisted(() => ({
  captureRequestError: vi.fn(),
  flush: vi.fn().mockResolvedValue(false),
  after: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureRequestError, flush }));
vi.mock("next/server", () => ({ after }));

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
    expect(after).toHaveBeenCalledTimes(1);
    const task = after.mock.calls[0][0] as () => Promise<unknown>;
    expect(flush).not.toHaveBeenCalled();
    await task();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test("falls back to a floating flush when no request scope exists", () => {
    after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    onRequestError(new Error("uncaught"), request, actionContext);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(captureRequestError).toHaveBeenCalledTimes(1);
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
