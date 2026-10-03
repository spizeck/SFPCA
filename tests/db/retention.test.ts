// PGlite integration tests for the retention service (#130). Pins the
// approved policy:
//   - verified receipts purge at 90 days after receipt_verified_at —
//     never from upload time; a missing stamp fails closed;
//   - abandoned/rejected submissions delete at 12 months — but a
//     submission with canonical descendants is a completed record;
//   - completed records anonymize 7 years after the registration
//     year's end — canonical rows stay, intake PII goes;
//   - active holds shield entities; release re-enables them;
//   - dry-run writes nothing; reruns are idempotent; logs carry no PII.
// Clocks are always injected — `now` is a fixed instant in every run.
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import { ANONYMIZED_OWNER_NAME } from "@/lib/retention";
import {
  applyRetentionHold,
  releaseRetentionHold,
  runRetentionPass,
  stampReceiptVerified,
} from "@/lib/registry/retention";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE retention_holds, registration_submissions, payment_events, payments, registrations, animals, audit_events CASCADE`,
  );
});

// Fixed reference instant — every test controls the clock.
const NOW = new Date("2026-10-05T12:00:00Z");

const OWNER = {
  ownerName: "Jane Owner",
  ownerAddress: "1 Windwardside",
  ownerPhone: "555-0100",
  ownerEmail: "jane@example.com",
};

type SubmissionSeed = Partial<
  typeof schema.registrationSubmissions.$inferInsert
>;

async function seedSubmission(seed: SubmissionSeed = {}) {
  const [row] = await db
    .insert(schema.registrationSubmissions)
    .values({
      ownerName: OWNER.ownerName,
      ownerAddress: OWNER.ownerAddress,
      ownerPhone: OWNER.ownerPhone,
      ownerEmail: OWNER.ownerEmail,
      status: "pending",
      submittedAt: new Date("2026-09-01T00:00:00Z"),
      ...seed,
    })
    .returning();
  return row;
}

async function seedAnimal() {
  const [row] = await db
    .insert(schema.animals)
    .values({ name: "Rex", species: "dog", sex: "male" })
    .returning();
  return row;
}

async function seedRegistration(submissionId: string, year: number) {
  const animal = await seedAnimal();
  const [row] = await db
    .insert(schema.registrations)
    .values({
      animalId: animal.id,
      submissionId,
      year,
      status: "active",
      submittedAt: new Date(Date.UTC(year, 5, 1)),
    })
    .returning();
  return row;
}

async function seedConfirmedPayment(
  submissionId: string,
  registrationId?: string,
) {
  const [row] = await db
    .insert(schema.payments)
    .values({
      submissionId,
      registrationId: registrationId ?? null,
      amountCents: 2500,
      kind: "payment",
      status: "confirmed",
      method: "cash",
      source: "staff",
      occurredAt: new Date("2026-06-01T00:00:00Z"),
      reference: "bank-ref-1",
      note: "walked in",
    })
    .returning();
  return row;
}

// Fake Storage bucket — records deletes, can simulate a missing object.
function fakeBucket({ missing = false } = {}) {
  const deleted: string[] = [];
  return {
    deleted,
    file(path: string) {
      return {
        delete: async () => {
          if (missing) {
            const err = new Error("not found") as Error & { code: number };
            err.code = 404;
            throw err;
          }
          deleted.push(path);
        },
      };
    },
  };
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const pass = (opts: Partial<Parameters<typeof runRetentionPass>[0]> = {}) =>
  runRetentionPass({
    db,
    bucket: fakeBucket(),
    now: NOW,
    dryRun: false,
    log: fakeLog(),
    ...opts,
  });

const getSubmission = (id: string) =>
  db
    .select()
    .from(schema.registrationSubmissions)
    .where(eq(schema.registrationSubmissions.id, id))
    .then((r) => r[0] ?? null);

describe("verified receipt purge (90 days)", () => {
  test("receipt verified < 90 days ago is retained", async () => {
    const s = await seedSubmission({
      paymentReceiptPath: "receipts/a",
      receiptVerifiedAt: new Date("2026-08-01T00:00:00Z"),
    });
    const bucket = fakeBucket();
    const summary = await pass({ bucket });
    expect(summary.receipts.purged).toBe(0);
    expect(bucket.deleted).toHaveLength(0);
    expect((await getSubmission(s.id))!.paymentReceiptPath).toBe(
      "receipts/a",
    );
  });

  test("receipt verified > 90 days ago is purged; row + ledger facts survive", async () => {
    const s = await seedSubmission({
      paymentReceiptPath: "receipts/a",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
      status: "approved",
      decidedAt: new Date("2026-06-01T00:00:00Z"),
    });
    const reg = await seedRegistration(s.id, 2026);
    const pay = await seedConfirmedPayment(s.id, reg.id);

    const bucket = fakeBucket();
    const summary = await pass({ bucket });
    expect(summary.receipts.purged).toBe(1);
    expect(bucket.deleted).toEqual(["receipts/a"]);

    const row = await getSubmission(s.id);
    expect(row).not.toBeNull();
    expect(row!.paymentReceiptPath).toBeNull();
    expect(row!.receiptPurgedAt).not.toBeNull();
    // Structured financial facts are untouched.
    expect(row!.ownerEmail).toBe(OWNER.ownerEmail);
    const [payment] = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, pay.id));
    expect(payment.status).toBe("confirmed");
    expect(payment.amountCents).toBe(2500);
    // The purge itself is auditable.
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "receipt-retention-purge"));
    expect(audit).toHaveLength(1);
  });

  test("already-missing object still marks the row purged (idempotent)", async () => {
    const s = await seedSubmission({
      paymentReceiptPath: "receipts/a",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
    });
    const bucket = fakeBucket({ missing: true });
    const summary = await pass({ bucket });
    expect(summary.receipts.purged).toBe(1);
    expect(summary.receipts.failed).toBe(0);
    const row = await getSubmission(s.id);
    expect(row!.paymentReceiptPath).toBeNull();
    expect(row!.receiptPurgedAt).not.toBeNull();
  });

  test("unverified receipt is never aged from upload/submission time", async () => {
    // Approved (not abandoned) and inside the completed window — no
    // other phase can touch this row; only the 90-day clock could, and
    // a missing stamp fails closed.
    const s = await seedSubmission({
      status: "approved",
      paymentReceiptPath: "receipts/a",
      receiptVerifiedAt: null,
      submittedAt: new Date("2020-06-01T00:00:00Z"),
      decidedAt: new Date("2020-06-02T00:00:00Z"),
    });
    const summary = await pass();
    expect(summary.receipts.eligible).toBe(0);
    expect(summary.receipts.purged).toBe(0);
    expect((await getSubmission(s.id))!.paymentReceiptPath).toBe(
      "receipts/a",
    );
  });

  test("repeated runs are idempotent — nothing purged twice", async () => {
    await seedSubmission({
      paymentReceiptPath: "receipts/a",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
    });
    const first = await pass();
    expect(first.receipts.purged).toBe(1);
    const second = await pass();
    expect(second.receipts.eligible).toBe(0);
    expect(second.receipts.purged).toBe(0);
  });
});

describe("abandoned / unsuccessful submissions (12 months)", () => {
  test("pending submission < 12 months old is retained", async () => {
    const s = await seedSubmission({
      submittedAt: new Date("2025-11-01T00:00:00Z"),
    });
    const summary = await pass();
    expect(summary.abandonedSubmissions.deleted).toBe(0);
    expect(await getSubmission(s.id)).not.toBeNull();
  });

  test("pending submission > 12 months old is deleted with its receipt", async () => {
    const s = await seedSubmission({
      submittedAt: new Date("2025-10-01T00:00:00Z"),
      paymentReceiptPath: "receipts/old",
    });
    const bucket = fakeBucket();
    const summary = await pass({ bucket });
    expect(summary.abandonedSubmissions.deleted).toBe(1);
    expect(bucket.deleted).toEqual(["receipts/old"]);
    expect(await getSubmission(s.id)).toBeNull();
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "retention-delete"));
    expect(audit).toHaveLength(1);
  });

  test("rejected submission ages from decided_at, not submitted_at", async () => {
    // Submitted long ago but decided recently — must be retained.
    const recent = await seedSubmission({
      status: "rejected",
      submittedAt: new Date("2020-01-01T00:00:00Z"),
      decidedAt: new Date("2026-09-01T00:00:00Z"),
    });
    // Rejected long ago — eligible.
    const old = await seedSubmission({
      status: "rejected",
      submittedAt: new Date("2020-01-01T00:00:00Z"),
      decidedAt: new Date("2025-09-01T00:00:00Z"),
    });
    const summary = await pass();
    expect(summary.abandonedSubmissions.deleted).toBe(1);
    expect(await getSubmission(recent.id)).not.toBeNull();
    expect(await getSubmission(old.id)).toBeNull();
  });

  test("rejected submission with no decided_at fails closed", async () => {
    const s = await seedSubmission({
      status: "rejected",
      submittedAt: new Date("2020-01-01T00:00:00Z"),
      decidedAt: null,
    });
    await pass();
    expect(await getSubmission(s.id)).not.toBeNull();
  });

  test("an old pending submission with a canonical registration is NOT abandoned", async () => {
    const s = await seedSubmission({
      submittedAt: new Date("2024-01-01T00:00:00Z"),
      status: "pending",
    });
    await seedRegistration(s.id, 2024);
    const summary = await pass();
    expect(summary.abandonedSubmissions.deleted).toBe(0);
    expect(summary.abandonedSubmissions.linkedSkipped).toBe(1);
    expect(await getSubmission(s.id)).not.toBeNull();
  });

  test("an approved submission is never treated as abandoned", async () => {
    const s = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2020-01-01T00:00:00Z"),
      decidedAt: new Date("2020-02-01T00:00:00Z"),
    });
    await pass();
    expect(await getSubmission(s.id)).not.toBeNull();
  });

  test("a held abandoned submission cannot starve the batch", async () => {
    // The held row is the oldest — filtered in SQL it cannot occupy
    // the batch of 1 and starve the actionable row behind it.
    const held = await seedSubmission({
      submittedAt: new Date("2024-01-01T00:00:00Z"),
    });
    const free = await seedSubmission({
      submittedAt: new Date("2025-01-01T00:00:00Z"),
    });
    await applyRetentionHold(
      "registration_submission",
      held.id,
      "audit",
      "staff",
      null,
      db,
    );
    const summary = await pass({ batchSize: 1 });
    expect(summary.abandonedSubmissions.deleted).toBe(1);
    expect(await getSubmission(free.id)).toBeNull();
    expect(await getSubmission(held.id)).not.toBeNull();
  });
});

describe("completed records (7 years after year end)", () => {
  test("registration inside the window keeps submission PII", async () => {
    // maxYear for NOW (Oct 2026) is 2018 — a 2019 registration is
    // inside its window until Jan 1 2027.
    const s = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2019-06-01T00:00:00Z"),
      decidedAt: new Date("2019-06-02T00:00:00Z"),
    });
    await seedRegistration(s.id, 2019);
    const summary = await pass();
    expect(summary.completedRecords.submissionsAnonymized).toBe(0);
    const row = await getSubmission(s.id);
    expect(row!.ownerEmail).toBe(OWNER.ownerEmail);
    expect(row!.ownerName).toBe(OWNER.ownerName);
  });

  test("expired record: submission PII anonymized, canonical rows kept", async () => {
    const s = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-06-01T00:00:00Z"),
      decidedAt: new Date("2018-06-02T00:00:00Z"),
    });
    const reg = await seedRegistration(s.id, 2018);
    await seedConfirmedPayment(s.id, reg.id);
    await db
      .update(schema.registrations)
      .set({ notes: "owner asked about renewal" })
      .where(eq(schema.registrations.id, reg.id));

    const summary = await pass();
    expect(summary.completedRecords.registrationsEligible).toBe(1);
    expect(summary.completedRecords.submissionsAnonymized).toBe(1);
    expect(summary.completedRecords.registrationsAnonymized).toBe(1);
    expect(summary.completedRecords.paymentsAnonymized).toBe(1);

    const sub = await getSubmission(s.id);
    expect(sub!.ownerName).toBe(ANONYMIZED_OWNER_NAME);
    expect(sub!.ownerEmail).toBeNull();
    expect(sub!.ownerPhone).toBeNull();
    expect(sub!.ownerAddress).toBeNull();

    // Canonical animal + registration + payment facts survive.
    const [animal] = await db
      .select()
      .from(schema.animals)
      .where(eq(schema.animals.id, reg.animalId));
    expect(animal).not.toBeUndefined();
    const [regRow] = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.id, reg.id));
    expect(regRow.notes).toBeNull();
    expect(regRow.year).toBe(2018);
    const [payRow] = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.registrationId, reg.id));
    expect(payRow.amountCents).toBe(2500);
    expect(payRow.reference).toBeNull();
    expect(payRow.note).toBeNull();
  });

  test("exact boundary: year == maxYear is eligible, maxYear+1 is not", async () => {
    // NOW = Oct 2026 → maxYear = 2018 (2019's window ends Dec 31 2026).
    const expired = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-06-01T00:00:00Z"),
    });
    await seedRegistration(expired.id, 2018);
    const inside = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2019-06-01T00:00:00Z"),
    });
    await seedRegistration(inside.id, 2019);

    const summary = await pass();
    expect((await getSubmission(expired.id))!.ownerName).toBe(
      ANONYMIZED_OWNER_NAME,
    );
    expect((await getSubmission(inside.id))!.ownerName).toBe(
      OWNER.ownerName,
    );
    // One day earlier (Dec 31 2025) the 2019 record is NOT eligible.
    const boundary = await runRetentionPass({
      db,
      bucket: fakeBucket(),
      now: new Date("2025-12-31T23:59:59Z"),
      dryRun: true,
      log: fakeLog(),
    });
    expect(boundary.completedRecords.registrationsEligible).toBe(0);
  });

  test("anonymization is idempotent", async () => {
    const s = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-06-01T00:00:00Z"),
    });
    await seedRegistration(s.id, 2018);
    await pass();
    const second = await pass();
    expect(second.completedRecords.submissionsAnonymized).toBe(0);
  });

  test("the clock follows the newest linked registration year", async () => {
    // Intake submitted in 2018 but linked to a 2026 registration —
    // retention follows 2026's window, not the intake date.
    const s = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-06-01T00:00:00Z"),
      decidedAt: new Date("2018-06-02T00:00:00Z"),
    });
    await seedRegistration(s.id, 2026);
    const summary = await pass();
    expect(summary.completedRecords.submissionsAnonymized).toBe(0);
    expect((await getSubmission(s.id))!.ownerName).toBe(OWNER.ownerName);
  });

  test("a submission with no linked registration ages by its own year", async () => {
    const s = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-06-01T00:00:00Z"),
      decidedAt: new Date("2018-06-02T00:00:00Z"),
    });
    const summary = await pass();
    expect(summary.completedRecords.submissionsAnonymized).toBe(1);
    expect((await getSubmission(s.id))!.ownerName).toBe(
      ANONYMIZED_OWNER_NAME,
    );
  });

  test("held registrations are excluded from bounded anonymization batches", async () => {
    // Held registration has notes and is older; the free one must
    // still be anonymized in the same bounded batch.
    const heldSub = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-01-01T00:00:00Z"),
    });
    const heldReg = await seedRegistration(heldSub.id, 2018);
    const freeSub = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-02-01T00:00:00Z"),
    });
    const freeReg = await seedRegistration(freeSub.id, 2018);
    for (const reg of [heldReg, freeReg]) {
      await db
        .update(schema.registrations)
        .set({ notes: "stray detail" })
        .where(eq(schema.registrations.id, reg.id));
    }
    await applyRetentionHold(
      "registration",
      heldReg.id,
      "legal",
      "staff",
      null,
      db,
    );
    const summary = await pass({ batchSize: 1 });
    expect(summary.completedRecords.registrationsAnonymized).toBe(1);
    const rows = await db.select().from(schema.registrations);
    expect(
      rows.find((r) => r.id === heldReg.id)!.notes,
    ).toBe("stray detail");
    expect(rows.find((r) => r.id === freeReg.id)!.notes).toBeNull();
    expect(summary.completedRecords.registrationsHeld).toBe(1);
  });
});

describe("retention holds", () => {
  test("a held receipt is skipped; release re-enables it", async () => {
    const s = await seedSubmission({
      paymentReceiptPath: "receipts/held",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
    });
    expect(
      await applyRetentionHold(
        "registration_submission",
        s.id,
        "audit in progress",
        "staff@example.com",
        null,
        db,
      ),
    ).toEqual({ ok: true });

    const held = await pass();
    expect(held.receipts.purged).toBe(0);
    expect(held.receipts.heldSkipped).toBe(1);
    expect((await getSubmission(s.id))!.paymentReceiptPath).toBe(
      "receipts/held",
    );

    expect(
      await releaseRetentionHold(
        "registration_submission",
        s.id,
        "staff@example.com",
        null,
        db,
      ),
    ).toEqual({ ok: true });
    const freed = await pass();
    expect(freed.receipts.purged).toBe(1);
  });

  test("a held registration shields its linked submission's PII", async () => {
    const s = await seedSubmission({
      status: "approved",
      submittedAt: new Date("2018-06-01T00:00:00Z"),
    });
    const reg = await seedRegistration(s.id, 2018);
    await applyRetentionHold(
      "registration",
      reg.id,
      "legal hold",
      "staff@example.com",
      null,
      db,
    );
    const summary = await pass();
    expect(summary.completedRecords.submissionsAnonymized).toBe(0);
    expect(summary.completedRecords.heldSkipped).toBeGreaterThanOrEqual(1);
    expect((await getSubmission(s.id))!.ownerEmail).toBe(
      OWNER.ownerEmail,
    );
  });

  test("a held registration shields the linked submission's receipt", async () => {
    // The receipt's 90-day window expired, but a registration-level
    // hold protects the whole intake family — including the receipt.
    const s = await seedSubmission({
      status: "approved",
      decidedAt: new Date("2026-06-02T00:00:00Z"),
      paymentReceiptPath: "receipts/family-held",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
    });
    const reg = await seedRegistration(s.id, 2026);
    await applyRetentionHold(
      "registration",
      reg.id,
      "dispute",
      "staff@example.com",
      null,
      db,
    );
    const bucket = fakeBucket();
    const summary = await pass({ bucket });
    expect(summary.receipts.purged).toBe(0);
    expect(summary.receipts.heldSkipped).toBe(1);
    expect(bucket.deleted).toHaveLength(0);
    expect((await getSubmission(s.id))!.paymentReceiptPath).toBe(
      "receipts/family-held",
    );
  });

  test("a held row cannot starve the batch", async () => {
    // Held receipt is the OLDEST eligible-aged row — filtered in SQL,
    // it cannot occupy the batch of 1 and starve the actionable rows.
    const held = await seedSubmission({
      status: "approved",
      decidedAt: new Date("2026-05-02T00:00:00Z"),
      paymentReceiptPath: "receipts/held",
      receiptVerifiedAt: new Date("2026-05-01T00:00:00Z"),
    });
    await seedSubmission({
      status: "approved",
      decidedAt: new Date("2026-06-02T00:00:00Z"),
      paymentReceiptPath: "receipts/free",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
    });
    await applyRetentionHold(
      "registration_submission",
      held.id,
      "audit",
      "staff",
      null,
      db,
    );
    const bucket = fakeBucket();
    const summary = await pass({ bucket, batchSize: 1 });
    expect(summary.receipts.purged).toBe(1);
    expect(bucket.deleted).toEqual(["receipts/free"]);
    expect((await getSubmission(held.id))!.paymentReceiptPath).toBe(
      "receipts/held",
    );
  });

  test("hold write paths validate input and stay auditable", async () => {
    // Bad inputs are refused before any write.
    expect(
      await applyRetentionHold(
        "registration_submission",
        "not-a-uuid",
        "reason",
        "staff",
        null,
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await applyRetentionHold(
        "registration_submission",
        crypto.randomUUID(),
        "   ",
        "staff",
        null,
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await applyRetentionHold(
        "registration_submission",
        crypto.randomUUID(),
        "reason",
        "staff",
        null,
        db,
      ),
    ).toEqual({ ok: false, reason: "not-found" });

    const s = await seedSubmission();
    await applyRetentionHold(
      "registration_submission",
      s.id,
      "first",
      "staff",
      null,
      db,
    );
    // A second active hold is a conflict, never a silent replace.
    expect(
      await applyRetentionHold(
        "registration_submission",
        s.id,
        "second",
        "staff",
        null,
        db,
      ),
    ).toEqual({ ok: false, reason: "conflict" });

    await releaseRetentionHold(
      "registration_submission",
      s.id,
      "staff",
      null,
      db,
    );
    // Releasing a second time finds no active hold.
    expect(
      await releaseRetentionHold(
        "registration_submission",
        s.id,
        "staff",
        null,
        db,
      ),
    ).toEqual({ ok: false, reason: "not-found" });

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, s.id));
    expect(audit.map((a) => a.action)).toEqual([
      "retention-hold",
      "retention-hold-release",
    ]);
  });
});

describe("dry run and logging", () => {
  test("dry-run reports counts but writes nothing", async () => {
    const s = await seedSubmission({
      paymentReceiptPath: "receipts/dry",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
      submittedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const bucket = fakeBucket();
    const summary = await runRetentionPass({
      db,
      bucket,
      now: NOW,
      dryRun: true,
      log: fakeLog(),
    });
    expect(summary.receipts.eligible).toBe(1);
    expect(summary.abandonedSubmissions.eligible).toBe(1);
    expect(bucket.deleted).toHaveLength(0);
    const row = await getSubmission(s.id);
    expect(row!.paymentReceiptPath).toBe("receipts/dry");
    const audit = await db.select().from(schema.auditEvents);
    expect(audit).toHaveLength(0);
  });

  test("purge logs contain no PII or identifiers", async () => {
    await seedSubmission({
      paymentReceiptPath: "receipts/secret",
      receiptVerifiedAt: new Date("2026-06-01T00:00:00Z"),
    });
    await seedSubmission({
      submittedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const log = fakeLog();
    await runRetentionPass({
      db,
      bucket: fakeBucket(),
      now: NOW,
      dryRun: false,
      log,
    });
    const emitted = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    for (const pii of [
      OWNER.ownerName,
      OWNER.ownerEmail,
      OWNER.ownerPhone,
      OWNER.ownerAddress,
      "receipts/secret",
    ]) {
      expect(emitted).not.toContain(pii);
    }
    // No entity uuid may leak either.
    expect(emitted).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});

describe("stampReceiptVerified", () => {
  test("stamps once when a receipt exists; never overwrites or stamps receipt-less rows", async () => {
    const withReceipt = await seedSubmission({
      paymentReceiptPath: "receipts/stamped",
    });
    await stampReceiptVerified(db, withReceipt.id);
    const first = await getSubmission(withReceipt.id);
    expect(first!.receiptVerifiedAt).not.toBeNull();

    // Second call must not move the stamp.
    const stamped = first!.receiptVerifiedAt!;
    await db.execute(sql`SELECT pg_sleep(0.01)`);
    await stampReceiptVerified(db, withReceipt.id);
    expect(
      (await getSubmission(withReceipt.id))!.receiptVerifiedAt!.getTime(),
    ).toBe(stamped.getTime());

    const noReceipt = await seedSubmission();
    await stampReceiptVerified(db, noReceipt.id);
    expect((await getSubmission(noReceipt.id))!.receiptVerifiedAt).toBeNull();
  });
});
