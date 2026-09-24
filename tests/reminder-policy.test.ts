// Unit tests for the reminder policy layer (#172). Pure functions only —
// idempotency-key derivation, touch vocabulary, and cooldown math must be
// deterministic for a given asOf so evaluators are reproducible.
import { describe, expect, test } from "vitest";
import {
  daysSince,
  isReminderKind,
  isSendTouch,
  reminderKey,
  REMINDER_KINDS,
  REMINDER_POLICIES,
  sendTouch,
  skipTouch,
} from "@/lib/reminders/policy";

describe("reminder kinds and policies", () => {
  test("only the implemented kind is registered — deferred classes are not", () => {
    // Registration/payment/annual-confirmation reminders are deferred
    // until #166/#169/#170 provide authoritative eligibility. A kind
    // appearing here means an evaluator may send for it — keep this
    // list honest.
    expect(REMINDER_KINDS).toEqual(["vaccination-reminder"]);
    expect(isReminderKind("vaccination-reminder")).toBe(true);
    expect(isReminderKind("registration-due-reminder")).toBe(false);
    expect(isReminderKind("registration-payment-reminder")).toBe(false);
    expect(isReminderKind("annual-confirmation-reminder")).toBe(false);
    expect(isReminderKind("")).toBe(false);
  });

  test("every policy is internally consistent", () => {
    for (const policy of Object.values(REMINDER_POLICIES)) {
      expect(REMINDER_KINDS).toContain(policy.kind);
      expect(policy.keyPrefix.length).toBeGreaterThan(0);
      expect(policy.cooldownDays).toBeGreaterThan(0);
      expect(policy.maxTouches).toBeGreaterThan(0);
      expect(policy.channel).toBe("email");
    }
  });
});

describe("reminderKey", () => {
  test("is deterministic and preserves the #173 key shape", () => {
    const a = reminderKey("vax-reminder", "vax-1", "2026-10-10", "reminder-1");
    const b = reminderKey("vax-reminder", "vax-1", "2026-10-10", "reminder-1");
    expect(a).toBe(b);
    expect(a).toBe("vax-reminder:vax-1:2026-10-10:reminder-1");
  });

  test("distinguishes entity, cycle, and touch", () => {
    const base = reminderKey("vax-reminder", "vax-1", "2026-10-10", "reminder-1");
    expect(reminderKey("vax-reminder", "vax-2", "2026-10-10", "reminder-1")).not.toBe(base);
    // A changed due date starts a new cycle — the second reminder for a
    // new date is a different logical send, not a duplicate.
    expect(reminderKey("vax-reminder", "vax-1", "2027-10-10", "reminder-1")).not.toBe(base);
    expect(reminderKey("vax-reminder", "vax-1", "2026-10-10", "reminder-2")).not.toBe(base);
  });
});

describe("touch vocabulary", () => {
  test("send touches are numbered; skip touches are namespaced", () => {
    expect(sendTouch(1)).toBe("reminder-1");
    expect(skipTouch("missing-email")).toBe("skip:missing-email");
    expect(isSendTouch("reminder-3")).toBe(true);
    expect(isSendTouch("skip:missing-email")).toBe(false);
    expect(isSendTouch(null)).toBe(false);
    expect(isSendTouch("reminder-")).toBe(true); // prefix-only still counts
  });
});

describe("daysSince", () => {
  test("whole days from a timestamp to an asOf date", () => {
    expect(daysSince(new Date("2026-09-01T12:00:00Z"), "2026-09-15")).toBe(13);
    expect(daysSince(new Date("2026-09-01T00:00:00Z"), "2026-09-15")).toBe(14);
    // Clock skew — a write stamped "after" asOf yields a negative gap.
    expect(daysSince(new Date("2026-09-20T00:00:00Z"), "2026-09-15")).toBe(-5);
  });
});
