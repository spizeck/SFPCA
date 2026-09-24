// Communication ledger + delivery service (#172). `communications` is
// the single authoritative record for every outbound message: evaluators
// register intent here (queued/skipped), the drain claims and sends
// queued rows, provider webhooks refine delivery state, and staff work
// the exception list. Provider dashboards are diagnostic aids — the row
// is the truth about what happened.
//
// Failure model (see src/lib/email.ts for the classification):
//   rejected    → 'failed' (terminal: provider refused the message)
//   unavailable → back to 'queued' for a later drain, bounded by
//                 MAX_SEND_ATTEMPTS (provider confirmed nothing went out)
//   uncertain   → 'failed' detail 'interrupted' — a response was lost;
//                 the provider may hold a copy, so automation never
//                 resends. Staff reconcile and requeue explicitly.
// A crashed 'sending' row is reclaimed the same way — an interrupted
// send is an uncertain send.
//
// Transaction boundary: claiming a row is one atomic UPDATE (no lock is
// ever held across the provider call); the outcome write is a second
// statement after the provider answers. Idempotency is two-layered —
// communications.idempotency_key stops duplicate intent, and the row
// uuid is sent as the provider idempotency key so a same-day retry of
// the same row cannot double-deliver.

import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  animals,
  auditEvents,
  communicationPreferences,
  communications,
  persons,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { isReminderKind } from "../reminders/policy";
import type { EmailSender } from "../email";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reasonable structural check — semantics (real deliverability) belong
// to the provider, and are surfaced back via webhooks/failures.
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

// Bounded vocabulary for communications.detail — machine-readable skip
// and failure reasons that the staff surface can group on. Never a
// free-text dump of provider errors or recipient data.
export const SKIP_REASONS = [
  "no-owner",
  "ambiguous-ownership",
  "household-no-contact",
  "missing-email",
  "invalid-email",
  "opted-out",
] as const;
export const FAILURE_REASONS = [
  "provider-rejected",
  "provider-unavailable",
  "retry-exhausted",
  "interrupted",
  "bounced",
  "complained",
  "delivery-failed",
  "malformed",
] as const;

// A claimed row holds 'sending' only for the duration of one provider
// call. Anything older means the worker died mid-send — the delivery
// state is unknowable, so the row becomes a staff exception rather than
// an automatic resend.
export const STALE_SENDING_MS = 30 * 60 * 1000;
// Hard bound on provider call attempts per row — auto-retries for
// 'unavailable' outcomes and manual staff requeues share the same cap.
export const MAX_SEND_ATTEMPTS = 5;

// --- Queueing (intent) -----------------------------------------------------

export interface CommunicationInsert {
  personId: string | null;
  animalId?: string | null;
  channel: string;
  kind: string;
  status: "queued" | "skipped";
  idempotencyKey: string;
  relatedType?: string | null;
  relatedId?: string | null;
  cycleKey?: string | null;
  touch?: string | null;
  recipient?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  detail?: string | null;
}

export type InsertOutcome = "inserted" | "duplicate" | "invalid-person";

// The single insert path for the ledger — evaluators and the #173
// vaccination foundation both funnel through here so the conflict /
// FK-error mapping lives in exactly one place.
export async function insertCommunication(
  input: CommunicationInsert,
  db: RegistryDb = getRegistryDb(),
): Promise<InsertOutcome> {
  try {
    const inserted = await db
      .insert(communications)
      .values({
        personId: input.personId,
        animalId: input.animalId ?? null,
        channel: input.channel,
        kind: input.kind,
        status: input.status,
        idempotencyKey: input.idempotencyKey,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        cycleKey: input.cycleKey ?? null,
        touch: input.touch ?? null,
        recipient: input.recipient ?? null,
        subject: input.subject ?? null,
        bodyText: input.bodyText ?? null,
        bodyHtml: input.bodyHtml ?? null,
        detail: input.detail ?? null,
        sentAt: null,
      })
      .onConflictDoNothing({ target: communications.idempotencyKey })
      .returning();
    return inserted.length === 0 ? "duplicate" : "inserted";
  } catch (error) {
    // FK violation on person_id/animal_id → the referenced row is gone.
    const code =
      (error as { code?: unknown })?.code ??
      (error as { cause?: { code?: unknown } })?.cause?.code;
    if (code === "23503") return "invalid-person";
    throw error;
  }
}

// --- Preferences -------------------------------------------------------------

// Opt-out applies only to kinds the policy marks optional — operational
// notices (registration due, balance owed, annual confirmation) are not
// suppressible by preference rows, so there is deliberately no global
// unsubscribe. Returns false for non-optional kinds by construction.
export async function isOptedOut(
  personId: string,
  channel: string,
  kind: string,
  db: RegistryDb = getRegistryDb(),
): Promise<boolean> {
  if (!UUID_RE.test(personId) || !isReminderKind(kind)) return false;
  const [row] = await db
    .select({ optedOut: communicationPreferences.optedOut })
    .from(communicationPreferences)
    .where(
      and(
        eq(communicationPreferences.personId, personId),
        eq(communicationPreferences.channel, channel),
        eq(communicationPreferences.kind, kind),
      ),
    )
    .limit(1);
  return row?.optedOut ?? false;
}

export type PreferenceResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "not-found" };

// Staff-recorded preference change (an owner self-serve path arrives
// with #166's portal). Upserts the current state and audits it against
// the person — the audit row is the history, the table the live state.
export async function setCommunicationPreference(
  input: {
    personId: string;
    channel: string;
    kind: string;
    optedOut: boolean;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PreferenceResult> {
  if (
    !UUID_RE.test(input.personId) ||
    !["email", "sms", "whatsapp", "phone"].includes(input.channel) ||
    !isReminderKind(input.kind) ||
    typeof input.optedOut !== "boolean"
  ) {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const [person] = await tx
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.id, input.personId));
    if (!person) return { ok: false as const, reason: "not-found" as const };

    const [row] = await tx
      .insert(communicationPreferences)
      .values({
        personId: input.personId,
        channel: input.channel,
        kind: input.kind,
        optedOut: input.optedOut,
        actorLabel,
      })
      .onConflictDoUpdate({
        target: [
          communicationPreferences.personId,
          communicationPreferences.channel,
          communicationPreferences.kind,
        ],
        set: {
          optedOut: input.optedOut,
          actorLabel,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) return { ok: false as const, reason: "invalid" as const };

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "person",
      entityId: input.personId,
      action: "communication-preference",
      // No contact details — the preference change itself is the audit.
      after: {
        channel: input.channel,
        kind: input.kind,
        optedOut: input.optedOut,
      },
    });
    return { ok: true as const };
  });
}

// --- Delivery drain ------------------------------------------------------------

export interface DrainCounts {
  claimed: number;
  sent: number;
  requeued: number; // provider unavailable — safe to try next drain
  failed: number;
  malformed: number;
  reclaimed: number; // stale 'sending' rows parked as interrupted
}

// Reclaim rows abandoned mid-send before attempting new work — an
// interrupted send is uncertain, so it is parked as 'failed'/'interrupted'
// for staff reconcile rather than resent.
export async function reclaimStaleSends(
  {
    now = new Date(),
    staleMs = STALE_SENDING_MS,
  }: { now?: Date; staleMs?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs);
  const reclaimed = await db
    .update(communications)
    .set({ status: "failed", detail: "interrupted", updatedAt: now })
    .where(
      and(
        eq(communications.status, "sending"),
        or(
          isNull(communications.lastAttemptAt),
          lt(communications.lastAttemptAt, cutoff),
        ),
      ),
    )
    .returning();
  return reclaimed.length;
}

// Claim → send → record outcome for queued rows, oldest first. Each row
// is claimed by a single atomic UPDATE so two drains on the same row
// cannot both send — the loser sees no row and moves on.
export async function deliverQueuedCommunications(
  {
    sender,
    limit = 100,
    now = new Date(),
  }: { sender: EmailSender; limit?: number; now?: Date },
  db: RegistryDb = getRegistryDb(),
): Promise<DrainCounts> {
  const counts: DrainCounts = {
    claimed: 0,
    sent: 0,
    requeued: 0,
    failed: 0,
    malformed: 0,
    reclaimed: 0,
  };

  counts.reclaimed = await reclaimStaleSends({ now }, db);

  const candidates = await db
    .select({ id: communications.id })
    .from(communications)
    .where(eq(communications.status, "queued"))
    .orderBy(asc(communications.createdAt))
    .limit(limit);

  for (const { id } of candidates) {
    // Atomic claim — the status guard makes a concurrent drain a no-op
    // rather than a duplicate send.
    const [claimed] = await db
      .update(communications)
      .set({
        status: "sending",
        attempts: sql`${communications.attempts} + 1`,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(communications.id, id),
          eq(communications.status, "queued"),
          lt(communications.attempts, MAX_SEND_ATTEMPTS),
        ),
      )
      .returning();
    if (!claimed) continue; // lost the race, or attempt cap reached
    counts.claimed++;

    // A queued row that cannot be expressed as an email is malformed —
    // terminal, never retried.
    if (
      claimed.channel !== "email" ||
      !claimed.recipient ||
      !EMAIL_RE.test(claimed.recipient) ||
      !claimed.subject ||
      !claimed.bodyText ||
      !claimed.bodyHtml
    ) {
      await db
        .update(communications)
        .set({ status: "failed", detail: "malformed", updatedAt: now })
        .where(eq(communications.id, id));
      counts.malformed++;
      continue;
    }

    const outcome = await sender.send(
      {
        to: claimed.recipient,
        subject: claimed.subject,
        text: claimed.bodyText,
        html: claimed.bodyHtml,
      },
      // The row uuid is the provider idempotency key: a retry of THIS
      // row within the provider's dedupe window can never double-send.
      id,
    );

    if (outcome.ok) {
      await db
        .update(communications)
        .set({
          status: "sent",
          sentAt: now,
          provider: sender.provider,
          providerMessageId: outcome.providerMessageId,
          detail: null,
          updatedAt: now,
        })
        .where(eq(communications.id, id));
      counts.sent++;
    } else if (outcome.failure === "unavailable") {
      // Provider explicitly refused/temporarily failed — nothing went
      // out. Back to the queue for a later drain unless the attempt cap
      // has been reached.
      if (claimed.attempts >= MAX_SEND_ATTEMPTS) {
        await db
          .update(communications)
          .set({
            status: "failed",
            detail: "retry-exhausted",
            updatedAt: now,
          })
          .where(eq(communications.id, id));
        counts.failed++;
      } else {
        await db
          .update(communications)
          .set({
            status: "queued",
            detail: "provider-unavailable",
            updatedAt: now,
          })
          .where(eq(communications.id, id));
        counts.requeued++;
      }
    } else {
      // 'rejected' and 'uncertain' are both terminal for automation:
      // rejected content will never be accepted, and an uncertain send
      // must never be blindly repeated.
      await db
        .update(communications)
        .set({
          status: "failed",
          detail:
            outcome.failure === "rejected"
              ? "provider-rejected"
              : "interrupted",
          updatedAt: now,
        })
        .where(eq(communications.id, id));
      counts.failed++;
    }
  }
  return counts;
}

// --- Provider event ingestion (webhooks) -------------------------------------

// Idempotent outcome application keyed on the provider message id:
// duplicate webhook deliveries are no-ops, and only forward-moving
// transitions apply. Returns the number of rows actually changed.
export async function markCommunicationDelivered(
  providerMessageId: string,
  deliveredAt: Date = new Date(),
  db: RegistryDb = getRegistryDb(),
): Promise<number> {
  const rows = await db
    .update(communications)
    .set({ status: "delivered", deliveredAt, updatedAt: deliveredAt })
    .where(
      and(
        eq(communications.providerMessageId, providerMessageId),
        eq(communications.status, "sent"),
      ),
    )
    .returning();
  return rows.length;
}

// A late bounce can arrive after 'delivered' — the recipient genuinely
// did not get the message, so 'failed' is the honest terminal state.
export async function markCommunicationFailed(
  providerMessageId: string,
  detail: string,
  at: Date = new Date(),
  db: RegistryDb = getRegistryDb(),
): Promise<number> {
  const rows = await db
    .update(communications)
    .set({ status: "failed", detail, updatedAt: at })
    .where(
      and(
        eq(communications.providerMessageId, providerMessageId),
        inArray(communications.status, ["sent", "delivered"]),
      ),
    )
    .returning();
  return rows.length;
}

// --- Staff operations -----------------------------------------------------------

export type RequeueResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "not-failed" | "attempts-exhausted" };

// Manual requeue of a failed send — the deliberate human decision that
// resolves an 'interrupted'/'rejected' row after staff reconcile the
// provider console or fix the recipient. Guarded so only a terminal
// 'failed' row with remaining attempt budget can return to 'queued'.
export async function requeueCommunication(
  id: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<RequeueResult> {
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(communications)
      .set({
        status: "queued",
        detail: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(communications.id, id),
          eq(communications.status, "failed"),
          lt(communications.attempts, MAX_SEND_ATTEMPTS),
        ),
      )
      .returning();
    if (!row) {
      const [existing] = await tx
        .select({
          status: communications.status,
          attempts: communications.attempts,
        })
        .from(communications)
        .where(eq(communications.id, id));
      if (!existing) return { ok: false as const, reason: "not-found" as const };
      return {
        ok: false as const,
        reason:
          existing.attempts >= MAX_SEND_ATTEMPTS
            ? ("attempts-exhausted" as const)
            : ("not-failed" as const),
      };
    }
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "communication",
      entityId: id,
      action: "requeue",
      after: { status: "queued" },
    });
    return { ok: true as const };
  });
}

// --- Staff reads ------------------------------------------------------------------

export interface AdminCommunication {
  id: string;
  kind: string;
  channel: string;
  status: string;
  detail: string | null;
  recipient: string | null;
  subject: string | null;
  touch: string | null;
  cycleKey: string | null;
  attempts: number;
  relatedType: string | null;
  relatedId: string | null;
  animalId: string | null;
  animalName: string | null;
  personId: string | null;
  personName: string | null;
  optedOut: boolean;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const COMM_COLUMNS = {
  id: communications.id,
  kind: communications.kind,
  channel: communications.channel,
  status: communications.status,
  detail: communications.detail,
  recipient: communications.recipient,
  subject: communications.subject,
  touch: communications.touch,
  cycleKey: communications.cycleKey,
  attempts: communications.attempts,
  relatedType: communications.relatedType,
  relatedId: communications.relatedId,
  animalId: communications.animalId,
  personId: communications.personId,
  sentAt: communications.sentAt,
  deliveredAt: communications.deliveredAt,
  createdAt: communications.createdAt,
  updatedAt: communications.updatedAt,
  animalName: animals.name,
  personName: persons.fullName,
  // Whether a preference row currently suppresses this kind/channel —
  // shown on exception rows so staff see the whole picture.
  optedOut:
    sql<boolean>`coalesce(${communicationPreferences.optedOut}, false)`,
} as const;

// Structural row type for the joined select — an explicit interface is
// clearer than a mapped type over the column map here.
interface CommRow {
  id: string;
  kind: string;
  channel: string;
  status: string;
  detail: string | null;
  recipient: string | null;
  subject: string | null;
  touch: string | null;
  cycleKey: string | null;
  attempts: number;
  relatedType: string | null;
  relatedId: string | null;
  animalId: string | null;
  personId: string | null;
  animalName: string | null;
  personName: string | null;
  optedOut: boolean;
  sentAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toCommDto(row: CommRow): AdminCommunication {
  const {
    animalName,
    personName,
    optedOut,
    sentAt,
    deliveredAt,
    createdAt,
    updatedAt,
    ...rest
  } = row;
  return {
    ...rest,
    animalName,
    personName,
    optedOut,
    sentAt: sentAt?.toISOString() ?? null,
    deliveredAt: deliveredAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function commSelect(db: RegistryDb) {
  return db
    .select(COMM_COLUMNS)
    .from(communications)
    .leftJoin(animals, eq(communications.animalId, animals.id))
    .leftJoin(persons, eq(communications.personId, persons.id))
    .leftJoin(
      communicationPreferences,
      and(
        eq(communicationPreferences.personId, communications.personId),
        eq(communicationPreferences.channel, communications.channel),
        eq(communicationPreferences.kind, communications.kind),
      ),
    );
}

// The exception list — what volunteers actually need to see. Failed
// deliveries (including interrupted/uncertain sends and bounces) and
// skipped reminders whose reason is a data gap to fix (no owner, no
// usable address) rather than a choice (opt-out rows are listed for
// context but flagged). Newest first.
export async function listCommunicationExceptions(
  { limit = 200 }: { limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<AdminCommunication[]> {
  const rows = await commSelect(db)
    .where(inArray(communications.status, ["failed", "skipped"]))
    .orderBy(desc(communications.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toCommDto);
}

// Recent send history — the success side of the ledger for context on
// the staff page. Full per-animal/per-person history comes from the
// scoped queries below.
export async function listRecentCommunications(
  { limit = 50 }: { limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<AdminCommunication[]> {
  const rows = await commSelect(db)
    .orderBy(desc(communications.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toCommDto);
}

export async function listCommunicationsForAnimal(
  animalId: string,
  { limit = 50 }: { limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<AdminCommunication[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await commSelect(db)
    .where(eq(communications.animalId, animalId))
    .orderBy(desc(communications.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toCommDto);
}

// Aggregate counts for the dashboard card — the composable summary
// #177's broader exception dashboard should reuse rather than re-query.
// "needsAction" is the count that matters operationally: failed sends
// plus skips whose reason is a fixable data gap.
export interface CommunicationSummary {
  queued: number;
  sending: number;
  sent: number;
  delivered: number;
  failed: number;
  skipped: number;
  needsAction: number;
}

export async function communicationSummary(
  db: RegistryDb = getRegistryDb(),
): Promise<CommunicationSummary> {
  const rows = await db
    .select({
      status: communications.status,
      count: sql<number>`count(*)::int`,
      actionable:
        sql<number>`count(*) filter (where ${communications.status} = 'failed' or (${communications.status} = 'skipped' and ${communications.detail} <> 'opted-out'))::int`,
    })
    .from(communications)
    .groupBy(communications.status);

  const summary: CommunicationSummary = {
    queued: 0,
    sending: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
    needsAction: 0,
  };
  for (const row of rows) {
    if (row.status in summary) {
      summary[row.status as keyof CommunicationSummary & string] = row.count;
    }
    summary.needsAction += row.actionable;
  }
  return summary;
}

// Strict current-owner resolution lives in ownership.ts (#166) — the
// canonical "who owns this animal" module — so every sender and every
// display projection share one definition that cannot drift.
export { resolveAnimalOwner } from "./ownership";
export type { ResolvedOwner } from "./ownership";
