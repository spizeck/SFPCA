// Email provider seam tests (#172). The Resend SDK is mocked — CI must
// never send real mail. What is under test is the classification that
// makes retries safe: rejected vs unavailable vs uncertain, plus the
// webhook signature verification implemented in-module.
import { describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

import {
  createResendSender,
  verifyResendWebhookSignature,
} from "@/lib/email";

const ENV = {
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "SFPCA <reminders@sabafpca.com>",
};

const MESSAGE = {
  to: "owner@example.com",
  subject: "Vaccination reminder for Rex",
  text: "Hello Jane, ...",
  html: "<p>Hello Jane, ...</p>",
};

describe("createResendSender", () => {
  test("returns null when either env var is missing — no silent sender", () => {
    expect(createResendSender({})).toBeNull();
    expect(
      createResendSender({ RESEND_API_KEY: "re_x" }),
    ).toBeNull();
    expect(
      createResendSender({ EMAIL_FROM: "SFPCA <a@b.c>" }),
    ).toBeNull();
  });

  test("a successful send records the provider message id", async () => {
    mockSend.mockResolvedValue({ data: { id: "msg_123" }, error: null });
    const sender = createResendSender(ENV)!;
    const outcome = await sender.send(MESSAGE, "row-uuid-1");
    expect(outcome).toEqual({ ok: true, providerMessageId: "msg_123" });
    // The row uuid is passed as the provider idempotency key.
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: ENV.EMAIL_FROM,
        to: ["owner@example.com"],
        subject: MESSAGE.subject,
        text: MESSAGE.text,
        html: MESSAGE.html,
      }),
      { idempotencyKey: "row-uuid-1" },
    );
  });

  test("a 4xx provider answer is 'rejected' — terminal, never retried", async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { name: "validation_error", statusCode: 422 },
    });
    const outcome = await createResendSender(ENV)!.send(MESSAGE, "k");
    expect(outcome).toEqual({
      ok: false,
      failure: "rejected",
      detail: "validation_error",
    });
  });

  test("5xx/429 answers are 'unavailable' — provider confirmed nothing went out", async () => {
    for (const statusCode of [500, 429]) {
      mockSend.mockResolvedValue({
        data: null,
        error: { name: "application_error", statusCode },
      });
      const outcome = await createResendSender(ENV)!.send(MESSAGE, "k");
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toBe("unavailable");
    }
  });

  test("a thrown error is 'uncertain' — the response never arrived", async () => {
    mockSend.mockRejectedValue(new Error("socket hangup"));
    const outcome = await createResendSender(ENV)!.send(MESSAGE, "k");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe("uncertain");
  });
});

// --- Webhook signature verification -------------------------------------
// Svix scheme: base64 HMAC-SHA256 over "<id>.<timestamp>.<raw body>",
// keyed by the base64 payload of the whsec_… secret.

const SECRET_KEY = Buffer.from("test-signing-key-32-bytes-padded!!").toString(
  "base64",
);
const SECRET = `whsec_${SECRET_KEY}`;

function sign(payload: string, id: string, timestamp: string): string {
  const sig = createHmac("sha256", Buffer.from(SECRET_KEY, "base64"))
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return `v1,${sig}`;
}

const NOW = Math.floor(Date.now() / 1000);
const PAYLOAD = JSON.stringify({
  type: "email.delivered",
  data: { email_id: "msg_1" },
});

function verify(overrides: Record<string, unknown> = {}) {
  return verifyResendWebhookSignature({
    payload: PAYLOAD,
    id: "msg_evt_1",
    timestamp: String(NOW),
    signature: sign(PAYLOAD, "msg_evt_1", String(NOW)),
    secret: SECRET,
    nowSeconds: NOW,
    ...overrides,
  } as Parameters<typeof verifyResendWebhookSignature>[0]);
}

describe("verifyResendWebhookSignature", () => {
  test("accepts a correctly signed payload", () => {
    expect(verify()).toBe(true);
  });

  test("rejects a tampered body, wrong secret, and forged signature", () => {
    expect(verify({ payload: `${PAYLOAD}x` })).toBe(false);
    expect(verify({ secret: `whsec_${Buffer.from("other-key-other-key-other-key-32!").toString("base64")}` })).toBe(false);
    expect(verify({ signature: "v1,AAAA" })).toBe(false);
  });

  test("rejects missing headers and a non-whsec secret", () => {
    expect(verify({ id: null })).toBe(false);
    expect(verify({ timestamp: null })).toBe(false);
    expect(verify({ signature: null })).toBe(false);
    expect(verify({ secret: "not-a-whsec" })).toBe(false);
  });

  test("rejects timestamps outside the replay window", () => {
    const stale = String(NOW - 3600);
    expect(
      verify({
        timestamp: stale,
        signature: sign(PAYLOAD, "msg_evt_1", stale),
      }),
    ).toBe(false);
    const future = String(NOW + 3600);
    expect(
      verify({
        timestamp: future,
        signature: sign(PAYLOAD, "msg_evt_1", future),
      }),
    ).toBe(false);
  });

  test("accepts a matching signature among several candidates (key rotation)", () => {
    const good = sign(PAYLOAD, "msg_evt_1", String(NOW));
    expect(verify({ signature: `v1,AAAA ${good}` })).toBe(true);
  });
});
