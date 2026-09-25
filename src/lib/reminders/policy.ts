// Reminder policy (#172) — the single place that defines WHEN each
// reminder class becomes eligible, how often it repeats, and how it
// stops. Pure configuration and helpers only: no DB, no server-only, so
// evaluators, tests, and docs all read the same rules.
//
// Deliberately not a rule engine: each kind has one small static
// policy. New reminder classes add an entry here AND an evaluator in
// src/lib/registry/reminders.ts — a kind with no evaluator is dormant
// configuration, never an implicit send.
//
// Deferred kinds — documented here so their intended cadence is
// reviewable, but intentionally NOT registered because their
// authoritative eligibility sources do not exist yet:
//   'registration-payment-reminder'  — needs #170 (payment ledger +
//                                      authoritative outstanding balance)
//   ('annual-confirmation-reminder' left this list in #166,
//    'registration-due-reminder' left it in #169 — their eligibility
//    sources exist now)
//
// The reminder classes that exist today. 'vaccination-reminder' reads
// #173's listDueVaccinations; 'annual-confirmation-reminder' (#166)
// reads the canonical listOwnershipsRequiringConfirmation — an
// ownership relationship is due when no deliberate confirmation row
// exists within the period (never derived from updated_at);
// 'registration-due-reminder' (#169) reads the canonical
// listUnregisteredAnimals — an 'active' animal with no active
// registration row for the current period.
export const REMINDER_KINDS = [
  "vaccination-reminder",
  "annual-confirmation-reminder",
  "registration-due-reminder",
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export function isReminderKind(value: string): value is ReminderKind {
  return (REMINDER_KINDS as readonly string[]).includes(value);
}

export interface ReminderPolicy {
  kind: ReminderKind;
  // Prefix of the deterministic idempotency key:
  //   <keyPrefix>:<relatedId>:<cycleKey>:<touch>
  // 'vax-reminder' preserves the exact key format #173 established —
  // existing queued rows keep their identity.
  keyPrefix: string;
  channel: "email";
  // optional: a recipient opt-out (communication_preferences) suppresses
  //   sends — courtesy reminders a person may decline.
  // operational kinds (registration/payment/confirmation once they
  //   exist) are NOT suppressible by preference rows: an owner cannot
  //   unsubscribe from a legal/financial obligation notice, and no
  //   single switch may ever silence them.
  optional: boolean;
  // Minimum days between send-touches within one cycle — the cooldown
  // that keeps a daily evaluator from mailing the same person daily.
  cooldownDays: number;
  // Total send-touches per cycle; 'skip:<reason>' exception rows do not
  // consume touches. After the cap, the case belongs to staff — the vet
  // queue / exception surface still shows the underlying condition.
  maxTouches: number;
}

export const REMINDER_POLICIES: Record<ReminderKind, ReminderPolicy> = {
  "vaccination-reminder": {
    kind: "vaccination-reminder",
    keyPrefix: "vax-reminder",
    channel: "email",
    optional: true,
    cooldownDays: 14,
    maxTouches: 3,
  },
  // Annual ownership re-affirmation (#166). Operational, not optional:
  // keeping the registry's owner records current is a responsibility of
  // the registered owner, so no preference row can silence it. One
  // reminder a month, twice per lapse — beyond that the relationship
  // belongs to staff exception handling, not more mail.
  "annual-confirmation-reminder": {
    kind: "annual-confirmation-reminder",
    keyPrefix: "confirm-reminder",
    channel: "email",
    optional: false,
    cooldownDays: 30,
    maxTouches: 2,
  },
  // Annual registration is due per calendar year (#169). Operational
  // like the confirmation reminder — a registry obligation, not a
  // preference. One reminder a month, twice per period; the staff
  // exception queue still shows the gap after that.
  "registration-due-reminder": {
    kind: "registration-due-reminder",
    keyPrefix: "reg-due",
    channel: "email",
    optional: false,
    cooldownDays: 30,
    maxTouches: 2,
  },
};

// Deterministic idempotency identity for one logical send. Every writer
// — the evaluator, a manual requeue, a retried cron — derives the same
// key for the same (entity, cycle, touch), so the unique index on
// communications.idempotency_key is the duplicate-send guarantee.
export function reminderKey(
  keyPrefix: string,
  relatedId: string,
  cycleKey: string,
  touch: string,
): string {
  return `${keyPrefix}:${relatedId}:${cycleKey}:${touch}`;
}

// Touch vocabulary: send-touches are 'reminder-1'…'reminder-N';
// exception rows use 'skip:<reason>' so they never consume a send touch.
export const SEND_TOUCH_PREFIX = "reminder-";
export function sendTouch(n: number): string {
  return `${SEND_TOUCH_PREFIX}${n}`;
}
export function skipTouch(reason: string): string {
  return `skip:${reason}`;
}
export function isSendTouch(touch: string | null): boolean {
  return touch !== null && touch.startsWith(SEND_TOUCH_PREFIX);
}

// Whole days between an ISO date-time/date and an asOf date (YYYY-MM-DD)
// — used for cooldown checks. Negative when the timestamp is "after"
// asOf (clock skew between the DB write and the evaluation date).
export function daysSince(timestamp: Date, asOf: string): number {
  const then = timestamp.getTime();
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  return Math.floor((asOfMs - then) / 86_400_000);
}
