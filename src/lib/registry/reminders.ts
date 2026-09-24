// Reminder orchestration (#172): eligibility → idempotent queueing →
// delivery drain, plus the dry-run path used before bulk sends.
//
// Evaluators are the seam. Each reminder kind owns one evaluator that
// reads AUTHORITATIVE domain state and returns decisions; this module
// owns persistence, idempotency-key derivation, counting, and delivery.
// A kind registers only when its eligibility source is implemented —
// today that is vaccination reminders (#173's listDueVaccinations) and
// annual-confirmation reminders (#166's listOwnershipsRequiring-
// Confirmation). Registration-due (#169) and unpaid-balance (#170)
// reminders are deliberately absent: their source tables have no
// writers yet, so any "eligibility" would be fabricated.
//
// Dry-run runs the same evaluation but writes nothing and never sends —
// it cannot send: the delivery drain is not invoked and no provider
// call exists on that path.

import "server-only";

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { communications, ownerships, persons } from "../db/schema";
import { getRegistryDb } from "../db/client";
import { getSiteUrl } from "../seo";
import { VACCINATION_DUE_SOON_DAYS } from "../vaccinations";
import { listDueVaccinations } from "./vaccinations";
import {
  householdContactFor,
  listOwnershipsRequiringConfirmation,
} from "./ownership";
import {
  daysSince,
  isSendTouch,
  reminderKey,
  REMINDER_POLICIES,
  sendTouch,
  skipTouch,
  type ReminderKind,
} from "../reminders/policy";
import {
  renderAnnualConfirmationReminder,
  renderVaccinationReminder,
} from "../reminders/templates";
import {
  deliverQueuedCommunications,
  EMAIL_RE,
  insertCommunication,
  isOptedOut,
  type DrainCounts,
} from "./communications";
import type { EmailSender } from "../email";
import type { RegistryDb } from "./public-animals";

// --- Evaluator contract ------------------------------------------------------

export type ReminderDecision =
  | {
      type: "send";
      personId: string;
      recipient: string;
      subject: string;
      bodyText: string;
      bodyHtml: string;
    }
  // Durable exception record — one row per (cycle, reason) so staff see
  // the data gap without the evaluator spamming duplicates.
  | { type: "skip"; personId: string | null; detail: string }
  // Counted, never persisted — cooldown/touch-cap suppression.
  | { type: "suppress"; detail: "cooldown" | "exhausted" };

export interface EvaluatedReminder {
  kind: ReminderKind;
  relatedType: string;
  relatedId: string;
  cycleKey: string;
  animalId: string | null;
  // Send touches are 'reminder-N'; skip rows carry 'skip:<reason>' so an
  // exception never consumes a send touch.
  touch: string;
  decision: ReminderDecision;
}

export interface ReminderEvaluatorContext {
  asOf: string;
  siteUrl: string;
}

export type ReminderEvaluator = (
  ctx: ReminderEvaluatorContext,
  db: RegistryDb,
) => Promise<EvaluatedReminder[]>;

// --- Vaccination reminders -----------------------------------------------------

// The first — and currently only — active evaluator. Eligibility is
// #173's listDueVaccinations (latest dose per series, effective date,
// deterministic owner projection); this evaluator adds the parts that
// belong to sending: touch selection under the policy's cooldown and
// cap, strict recipient resolution, and opt-out honoring.
export const evaluateVaccinationReminders: ReminderEvaluator = async (
  ctx,
  db,
) => {
  const policy = REMINDER_POLICIES["vaccination-reminder"];
  const due = await listDueVaccinations(
    { asOf: ctx.asOf, withinDays: VACCINATION_DUE_SOON_DAYS },
    db,
  );
  if (due.length === 0) return [];

  const vaccinationIds = due.map((d) => d.vaccination.id);
  const animalIds = [...new Set(due.map((d) => d.animal.id))];

  const [existingRows, ownershipCounts] = await Promise.all([
    // Every ledger row for these vaccinations — per-cycle filtering
    // happens in memory below. Touch history drives cadence decisions.
    db
      .select({
        relatedId: communications.relatedId,
        cycleKey: communications.cycleKey,
        touch: communications.touch,
        createdAt: communications.createdAt,
      })
      .from(communications)
      .where(
        and(
          eq(communications.kind, "vaccination-reminder"),
          eq(communications.relatedType, "vaccination"),
          inArray(communications.relatedId, vaccinationIds),
        ),
      ),
    // How many ownerships are simultaneously valid per animal at asOf.
    // The due projection picks one deterministic owner for display; for
    // SENDING, overlapping ownership is ambiguous — never guessed.
    db
      .select({
        animalId: ownerships.animalId,
        count: sql<number>`count(*)::int`,
      })
      .from(ownerships)
      .where(
        and(
          inArray(ownerships.animalId, animalIds),
          lte(ownerships.validFrom, ctx.asOf),
          or(isNull(ownerships.validTo), gt(ownerships.validTo, ctx.asOf)),
        ),
      )
      .groupBy(ownerships.animalId),
  ]);
  const ownershipCountByAnimal = new Map(
    ownershipCounts.map((r) => [r.animalId, r.count]),
  );

  const items: EvaluatedReminder[] = [];
  for (const row of due) {
    // Only the attention states are reminder-eligible — 'current' rows
    // inside the read window are not actionable yet.
    if (row.state !== "due-soon" && row.state !== "overdue") continue;

    const cycleRows = existingRows.filter(
      (r) =>
        r.relatedId === row.vaccination.id &&
        r.cycleKey === row.effectiveDate,
    );
    const sendTouches = cycleRows.filter((r) => isSendTouch(r.touch));

    const base = {
      kind: "vaccination-reminder" as const,
      relatedType: "vaccination",
      relatedId: row.vaccination.id,
      cycleKey: row.effectiveDate,
      animalId: row.animal.id,
    };

    if (sendTouches.length >= policy.maxTouches) {
      items.push({
        ...base,
        touch: sendTouch(sendTouches.length + 1),
        decision: { type: "suppress", detail: "exhausted" },
      });
      continue;
    }
    const lastTouchAt = sendTouches
      .map((r) => r.createdAt.getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    if (
      lastTouchAt > 0 &&
      daysSince(new Date(lastTouchAt), ctx.asOf) < policy.cooldownDays
    ) {
      items.push({
        ...base,
        touch: sendTouch(sendTouches.length + 1),
        decision: { type: "suppress", detail: "cooldown" },
      });
      continue;
    }

    const touch = sendTouch(sendTouches.length + 1);
    const owner = row.currentOwner;
    const skip = (detail: string, personId: string | null = null) =>
      items.push({
        ...base,
        touch: skipTouch(detail),
        decision: { type: "skip", personId, detail },
      });

    // Recipient resolution — fail closed on every ambiguous shape.
    if ((ownershipCountByAnimal.get(row.animal.id) ?? 0) > 1) {
      skip("ambiguous-ownership");
      continue;
    }
    if (!owner) {
      skip("no-owner");
      continue;
    }
    if (owner.kind === "household") {
      skip("household-no-contact");
      continue;
    }
    if (!owner.email) {
      skip("missing-email", owner.id);
      continue;
    }
    if (!EMAIL_RE.test(owner.email)) {
      skip("invalid-email", owner.id);
      continue;
    }
    if (
      policy.optional &&
      (await isOptedOut(owner.id, policy.channel, policy.kind, db))
    ) {
      skip("opted-out", owner.id);
      continue;
    }

    const rendered = renderVaccinationReminder({
      ownerName: owner.name,
      animalName: row.animal.name,
      vaccineName: row.vaccination.vaccineName,
      effectiveDate: row.effectiveDate,
      overdue: row.state === "overdue",
      siteUrl: ctx.siteUrl,
    });
    items.push({
      ...base,
      touch,
      decision: {
        type: "send",
        personId: owner.id,
        recipient: owner.email,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
      },
    });
  }
  return items;
};

// --- Annual confirmation reminders ----------------------------------------------

// The #166 evaluator: eligibility is the canonical
// listOwnershipsRequiringConfirmation — current owner↔animal
// relationships whose last deliberate confirmation is older than the
// period (or never happened; valid_from seeds the clock). Each row IS
// one relationship, so co-owners are reminded independently — there is
// no single-recipient ambiguity the way vaccination sends have. The
// cycle key is the relationship's due date, stable for the whole lapse.
export const evaluateAnnualConfirmationReminders: ReminderEvaluator =
  async (ctx, db) => {
    const policy = REMINDER_POLICIES["annual-confirmation-reminder"];
    const due = await listOwnershipsRequiringConfirmation(
      { asOf: ctx.asOf },
      db,
    );
    if (due.length === 0) return [];

    const ownershipIds = due.map((d) => d.ownershipId);
    const personIds = due
      .map((d) => d.personId)
      .filter((id): id is string => id !== null);
    const householdIds = due
      .map((d) => d.householdId)
      .filter((id): id is string => id !== null);

    const [existingRows, personRows, householdContacts] = await Promise.all([
      db
        .select({
          relatedId: communications.relatedId,
          cycleKey: communications.cycleKey,
          touch: communications.touch,
          createdAt: communications.createdAt,
        })
        .from(communications)
        .where(
          and(
            eq(communications.kind, "annual-confirmation-reminder"),
            eq(communications.relatedType, "ownership"),
            inArray(communications.relatedId, ownershipIds),
          ),
        ),
      personIds.length > 0
        ? db
            .select({ id: persons.id, email: persons.email })
            .from(persons)
            .where(inArray(persons.id, personIds))
        : Promise.resolve([]),
      householdContactFor(householdIds, db),
    ]);
    const emailByPersonId = new Map(personRows.map((p) => [p.id, p.email]));

    const items: EvaluatedReminder[] = [];
    for (const row of due) {
      const cycleRows = existingRows.filter(
        (r) => r.relatedId === row.ownershipId && r.cycleKey === row.dueOn,
      );
      const sendTouches = cycleRows.filter((r) => isSendTouch(r.touch));

      const base = {
        kind: "annual-confirmation-reminder" as const,
        relatedType: "ownership",
        relatedId: row.ownershipId,
        cycleKey: row.dueOn,
        animalId: row.animalId,
      };

      if (sendTouches.length >= policy.maxTouches) {
        items.push({
          ...base,
          touch: sendTouch(sendTouches.length + 1),
          decision: { type: "suppress", detail: "exhausted" },
        });
        continue;
      }
      const lastTouchAt = sendTouches
        .map((r) => r.createdAt.getTime())
        .reduce((a, b) => Math.max(a, b), 0);
      if (
        lastTouchAt > 0 &&
        daysSince(new Date(lastTouchAt), ctx.asOf) < policy.cooldownDays
      ) {
        items.push({
          ...base,
          touch: sendTouch(sendTouches.length + 1),
          decision: { type: "suppress", detail: "cooldown" },
        });
        continue;
      }

      const touch = sendTouch(sendTouches.length + 1);
      const skip = (detail: string, personId: string | null = null) =>
        items.push({
          ...base,
          touch: skipTouch(detail),
          decision: { type: "skip", personId, detail },
        });

      // Recipient: the person-side owner's email, or the owning
      // household's contactable member. No opt-out check — operational
      // kinds are not suppressible by preference rows.
      let recipientId: string | null;
      let recipientName: string;
      let recipientEmail: string | null;
      if (row.personId) {
        recipientId = row.personId;
        recipientName = row.personName ?? "Owner";
        recipientEmail = emailByPersonId.get(row.personId) ?? null;
      } else {
        const contact = householdContacts.get(row.householdId!);
        if (!contact) {
          skip("household-no-contact");
          continue;
        }
        recipientId = contact.personId;
        recipientName = contact.name;
        recipientEmail = contact.email;
      }
      if (!recipientEmail) {
        skip("missing-email", recipientId);
        continue;
      }
      if (!EMAIL_RE.test(recipientEmail)) {
        skip("invalid-email", recipientId);
        continue;
      }

      const rendered = renderAnnualConfirmationReminder({
        ownerName: recipientName,
        animalName: row.animalName,
        dueOn: row.dueOn,
        siteUrl: ctx.siteUrl,
      });
      items.push({
        ...base,
        touch,
        decision: {
          type: "send",
          personId: recipientId,
          recipient: recipientEmail,
          subject: rendered.subject,
          bodyText: rendered.text,
          bodyHtml: rendered.html,
        },
      });
    }
    return items;
  };

// Registered evaluators — one per implemented reminder kind. Deferred
// classes are documented in policy.ts and intentionally absent here.
const EVALUATORS: Record<ReminderKind, ReminderEvaluator> = {
  "vaccination-reminder": evaluateVaccinationReminders,
  "annual-confirmation-reminder": evaluateAnnualConfirmationReminders,
};

const REGISTERED_KINDS = Object.keys(EVALUATORS) as ReminderKind[];

// --- The cycle -----------------------------------------------------------------

export interface ReminderCycleResult {
  asOf: string;
  dryRun: boolean;
  evaluated: number;
  // Live mode: rows written. Dry-run: rows that WOULD be written.
  queued: number;
  skipped: number;
  // Items the ledger already recorded (idempotent re-evaluation) or the
  // policy suppressed (cooldown, touch cap).
  suppressed: number;
  suppressedByReason: Record<string, number>;
  skippedByReason: Record<string, number>;
  // Delivery phase — null in dry-run and when no sender is configured.
  delivery: DrainCounts | "not-configured" | "dry-run";
}

export async function runReminderCycle(
  {
    asOf,
    dryRun = false,
    sender = null,
    sendLimit = 100,
  }: {
    asOf: string;
    dryRun?: boolean;
    sender?: EmailSender | null;
    sendLimit?: number;
  },
  db: RegistryDb = getRegistryDb(),
): Promise<ReminderCycleResult> {
  const result: ReminderCycleResult = {
    asOf,
    dryRun,
    evaluated: 0,
    queued: 0,
    skipped: 0,
    suppressed: 0,
    suppressedByReason: {},
    skippedByReason: {},
    delivery: "not-configured",
  };

  const ctx: ReminderEvaluatorContext = { asOf, siteUrl: getSiteUrl() };

  for (const kind of REGISTERED_KINDS) {
    const evaluator = EVALUATORS[kind];
    const policy = REMINDER_POLICIES[kind];
    const items = await evaluator(ctx, db);
    result.evaluated += items.length;
    if (items.length === 0) continue;

    // The keys these items would claim — dry-run uses the same
    // uniqueness the live insert enforces so its counts are honest.
    const keys = items.map((item) =>
      reminderKey(policy.keyPrefix, item.relatedId, item.cycleKey, item.touch),
    );
    const existing = dryRun
      ? new Set(
          (
            await db
              .select({ key: communications.idempotencyKey })
              .from(communications)
              .where(inArray(communications.idempotencyKey, keys))
          ).map((r) => r.key),
        )
      : null;

    for (const [i, item] of items.entries()) {
      if (item.decision.type === "suppress") {
        result.suppressed++;
        result.suppressedByReason[item.decision.detail] =
          (result.suppressedByReason[item.decision.detail] ?? 0) + 1;
        continue;
      }
      const key = keys[i];
      if (item.decision.type === "skip") {
        if (dryRun) {
          if (existing!.has(key)) result.suppressed++;
          else {
            result.skipped++;
            result.skippedByReason[item.decision.detail] =
              (result.skippedByReason[item.decision.detail] ?? 0) + 1;
          }
          continue;
        }
        const outcome = await insertCommunication(
          {
            personId: item.decision.personId,
            animalId: item.animalId,
            channel: policy.channel,
            kind: item.kind,
            status: "skipped",
            idempotencyKey: key,
            relatedType: item.relatedType,
            relatedId: item.relatedId,
            cycleKey: item.cycleKey,
            touch: item.touch,
            detail: item.decision.detail,
          },
          db,
        );
        if (outcome === "inserted") {
          result.skipped++;
          result.skippedByReason[item.decision.detail] =
            (result.skippedByReason[item.decision.detail] ?? 0) + 1;
        } else if (outcome === "duplicate") {
          result.suppressed++;
        } else {
          // The resolved person vanished mid-run — the skip row can't
          // reference them, so record the exception without the link.
          const retry = await insertCommunication(
            {
              personId: null,
              animalId: item.animalId,
              channel: policy.channel,
              kind: item.kind,
              status: "skipped",
              idempotencyKey: `${key}:orphaned`,
              relatedType: item.relatedType,
              relatedId: item.relatedId,
              cycleKey: item.cycleKey,
              touch: item.touch,
              detail: item.decision.detail,
            },
            db,
          );
          if (retry === "inserted") {
            result.skipped++;
            result.skippedByReason[item.decision.detail] =
              (result.skippedByReason[item.decision.detail] ?? 0) + 1;
          } else {
            result.suppressed++;
          }
        }
        continue;
      }

      // 'send'
      if (dryRun) {
        if (existing!.has(key)) result.suppressed++;
        else result.queued++;
        continue;
      }
      const outcome = await insertCommunication(
        {
          personId: item.decision.personId,
          animalId: item.animalId,
          channel: policy.channel,
          kind: item.kind,
          status: "queued",
          idempotencyKey: key,
          relatedType: item.relatedType,
          relatedId: item.relatedId,
          cycleKey: item.cycleKey,
          touch: item.touch,
          recipient: item.decision.recipient,
          subject: item.decision.subject,
          bodyText: item.decision.bodyText,
          bodyHtml: item.decision.bodyHtml,
        },
        db,
      );
      if (outcome === "inserted") result.queued++;
      else result.suppressed++;
    }
  }

  if (dryRun) {
    result.delivery = "dry-run";
  } else if (!sender) {
    result.delivery = "not-configured";
  } else {
    result.delivery = await deliverQueuedCommunications(
      { sender, limit: sendLimit },
      db,
    );
  }
  return result;
}
