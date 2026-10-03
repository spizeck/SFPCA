// Unit tests for the pre-launch demo lifecycle helpers (#275):
// the pure classifier (absent/unknown → 'live', never 'demo'), the
// demo email boundary (inert sink / single-override inbox — fictional
// recipients can never be reached), and the lifecycle-aware factory.
import { describe, expect, test, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

import {
  resolveAppLifecycle,
  isPrelaunchDemo,
  getAppLifecycle,
  getAppLifecycleStrict,
  getCachedAppLifecycle,
  resetCachedAppLifecycle,
  APP_LIFECYCLE_PRELAUNCH_DEMO,
  APP_LIFECYCLE_LIVE,
} from "@/lib/app-lifecycle";
import {
  createPrelaunchDemoSender,
  createLifecycleAwareSender,
} from "@/lib/email";

describe("resolveAppLifecycle", () => {
  test("prelaunch-demo row resolves to demo posture", () => {
    expect(resolveAppLifecycle("prelaunch-demo")).toBe(
      APP_LIFECYCLE_PRELAUNCH_DEMO,
    );
    expect(isPrelaunchDemo(APP_LIFECYCLE_PRELAUNCH_DEMO)).toBe(true);
  });

  test("missing or unknown rows resolve to live — never to demo", () => {
    for (const v of [null, undefined, "live", "garbage", ""]) {
      expect(resolveAppLifecycle(v)).toBe(APP_LIFECYCLE_LIVE);
    }
    expect(isPrelaunchDemo(APP_LIFECYCLE_LIVE)).toBe(false);
  });
});

const brokenDb = {
  select: () => {
    throw new Error("db down");
  },
} as any;
const emptyDb = {
  select: () => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
  }),
} as any;

describe("lifecycle read failure directions", () => {
  // The two callers disagree on the safe failure direction: presentation
  // (banner/SEO) fails OPEN to 'live' so a post-launch outage never
  // re-enables demo surfaces, while side-effecting paths (email sends,
  // destructive sweeps) must fail CLOSED.
  test("strict read returns undefined on db error (fail closed)", async () => {
    expect(await getAppLifecycleStrict(brokenDb)).toBeUndefined();
  });

  test("presentation read resolves live on db error (fail open)", async () => {
    expect(await getAppLifecycle(brokenDb)).toBe(APP_LIFECYCLE_LIVE);
  });

  test("strict read resolves a missing row to live", async () => {
    expect(await getAppLifecycleStrict(emptyDb)).toBe(APP_LIFECYCLE_LIVE);
  });
});

describe("getCachedAppLifecycle stickiness", () => {
  // A confirmed demo lifecycle must survive a later read failure — an
  // outage during the demo window must not drop noindex/robots
  // protections by resolving 'live'. A cold-start failure still
  // resolves 'live' (a fresh live deploy has nothing to preserve).
  let failNext = false;
  const flakyDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            failNext
              ? Promise.reject(new Error("db down"))
              : Promise.resolve([{ lifecycle: "prelaunch-demo" }]),
        }),
      }),
    }),
  } as any;

  test("read failure preserves a confirmed demo lifecycle", async () => {
    failNext = false;
    resetCachedAppLifecycle();
    expect(await getCachedAppLifecycle(flakyDb)).toBe(
      APP_LIFECYCLE_PRELAUNCH_DEMO,
    );
    failNext = true;
    // ttl=0 forces a fresh read past the memo window.
    expect(await getCachedAppLifecycle(flakyDb, 0)).toBe(
      APP_LIFECYCLE_PRELAUNCH_DEMO,
    );
  });

  test("cold-start read failure resolves live", async () => {
    resetCachedAppLifecycle();
    expect(await getCachedAppLifecycle(brokenDb)).toBe(APP_LIFECYCLE_LIVE);
  });
});

describe("createPrelaunchDemoSender", () => {
  test("default is the inert demo-sink: sends succeed, nothing leaves", async () => {
    const sender = createPrelaunchDemoSender({});
    expect(sender.provider).toBe("demo-sink");
    const outcome = await sender.send(
      { to: "anyone@real-world.org", subject: "s", text: "t" },
      "key-1",
    );
    expect(outcome.ok).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("DEMO_EMAIL_OVERRIDE_TO routes every message to one inbox", async () => {
    mockSend.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const sender = createPrelaunchDemoSender({
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "SFPCA <reminders@sabafpca.com>",
      DEMO_EMAIL_OVERRIDE_TO: "board-inbox@sabafpca.com",
    });
    expect(sender.provider).toBe("resend-demo-override");
    await sender.send(
      { to: "fictional@example.com", subject: "s", text: "t" },
      "key-2",
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["board-inbox@sabafpca.com"] }),
      expect.anything(),
    );
  });

  test("override without Resend config still resolves to the sink", () => {
    const sender = createPrelaunchDemoSender({
      DEMO_EMAIL_OVERRIDE_TO: "board-inbox@sabafpca.com",
    });
    expect(sender.provider).toBe("demo-sink");
  });
});

describe("createLifecycleAwareSender", () => {
  test("prelaunch-demo lifecycle can never produce the real sender", () => {
    const sender = createLifecycleAwareSender("prelaunch-demo", {
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "SFPCA <r@sabafpca.com>",
    });
    expect(sender?.provider).toBe("demo-sink");
  });

  test("live lifecycle produces the real sender (or null unconfigured)", () => {
    const env = {
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "SFPCA <r@sabafpca.com>",
    };
    expect(createLifecycleAwareSender("live", env)?.provider).toBe("resend");
    expect(createLifecycleAwareSender("live", {})).toBeNull();
  });

  test("unknown lifecycle values behave as live — never demo", () => {
    expect(
      createLifecycleAwareSender("unexpected-value", {
        RESEND_API_KEY: "re_test_key",
        EMAIL_FROM: "SFPCA <r@sabafpca.com>",
      })?.provider,
    ).toBe("resend");
  });
});
