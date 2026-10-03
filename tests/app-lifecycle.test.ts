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
