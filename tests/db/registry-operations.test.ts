// Registry operational domain tests (#183): animal admin mutations,
// registration submissions + review transitions, admin_users
// authorization, and the receipt-sweep existence check — all against
// PGlite so transactions, constraints, and optimistic locking run on
// real Postgres semantics.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  createAnimal,
  deleteAnimal,
  listAdminAnimals,
  updateAnimal,
  validateAnimalInput,
} from "@/lib/registry/animals";
import {
  createRegistrationSubmission,
  listRegistrationSubmissions,
  registrationSubmissionExists,
  updateSubmissionStatus,
} from "@/lib/registry/registrations";
import { findAdminUser, provisionAdminUser } from "@/lib/registry/admin-users";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

const VALID_ANIMAL = {
  name: "Rex",
  species: "dog",
  sex: "male",
  approxAge: "2 years",
  description: "friendly",
  lifecycleStatus: "available",
  photoUrls: [],
};

const VALID_SUBMISSION = {
  submissionId: "11111111-2222-4333-8444-555555555555",
  receiptPath: null,
  ownerName: "Jane Doe",
  ownerAddress: "Windwardside, Saba",
  ownerPhone: "+599 416 0000",
  ownerEmail: "jane@example.com",
  animals: [{ name: "Rex", type: "Dog", sex: "male", isFixed: "yes" }],
};

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

describe("animal domain service", () => {
  test("create + list round-trips the admin projection and writes an audit row", async () => {
    const result = await createAnimal(VALID_ANIMAL, "admin@test.dev", db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const listed = await listAdminAnimals(db);
    const row = listed.find((a) => a.id === result.animal.id);
    expect(row).toMatchObject({
      name: "Rex",
      species: "dog",
      lifecycleStatus: "available",
      legacyId: null,
    });

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, result.animal.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "create",
      actorLabel: "admin@test.dev",
      entityType: "animal",
    });
  });

  test("update applies changes, guards on stale updatedAt, and audits", async () => {
    const created = await createAnimal(VALID_ANIMAL, "admin@test.dev", db);
    if (!created.ok) throw new Error("setup failed");
    const before = created.animal;

    // A stale writer (an outdated updatedAt) is rejected as a conflict.
    const stale = await updateAnimal(
      before.id,
      { ...VALID_ANIMAL, name: "Renamed" },
      "1999-01-01T00:00:00.000Z",
      "other@test.dev",
      db,
    );
    expect(stale).toEqual({ ok: false, reason: "conflict" });

    const updated = await updateAnimal(
      before.id,
      { ...VALID_ANIMAL, lifecycleStatus: "adopted" },
      before.updatedAt,
      "admin@test.dev",
      db,
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.animal.lifecycleStatus).toBe("adopted");
    }

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, before.id));
    const actions = audit.map((a) => a.action).sort();
    // Only the successful update is audited — the conflicted write
    // never landed.
    expect(actions).toEqual(["create", "update"]);
  });

  test("update of a missing animal returns not-found", async () => {
    const result = await updateAnimal(
      "00000000-0000-4000-8000-000000000000",
      VALID_ANIMAL,
      "2026-01-01T00:00:00.000Z",
      "admin@test.dev",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  test("delete removes the row and audits the before-state", async () => {
    const created = await createAnimal(VALID_ANIMAL, "admin@test.dev", db);
    if (!created.ok) throw new Error("setup failed");

    const deleted = await deleteAnimal(created.animal.id, "admin@test.dev", db);
    expect(deleted.ok).toBe(true);

    const listed = await listAdminAnimals(db);
    expect(listed.find((a) => a.id === created.animal.id)).toBeUndefined();

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, created.animal.id));
    expect(audit.some((a) => a.action === "delete")).toBe(true);
  });

  test("invalid input is rejected before any write", async () => {
    expect(validateAnimalInput({ ...VALID_ANIMAL, name: " " })).toBe("name");
    expect(
      validateAnimalInput({ ...VALID_ANIMAL, species: "fish" }),
    ).toBe("species");
    expect(
      validateAnimalInput({ ...VALID_ANIMAL, lifecycleStatus: "gone" }),
    ).toBe("lifecycleStatus");
    const result = await createAnimal(
      { ...VALID_ANIMAL, species: "fish" },
      "admin@test.dev",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("registration submissions", () => {
  test("create stores owner snapshot, animals, and computed fee", async () => {
    const result = await createRegistrationSubmission(VALID_SUBMISSION, db);
    expect(result.ok).toBe(true);

    const listed = await listRegistrationSubmissions(db);
    const row = listed.find((r) => r.id === VALID_SUBMISSION.submissionId);
    expect(row).toMatchObject({
      ownerName: "Jane Doe",
      status: "pending",
      totalFeeCents: 1000, // fixed animal → $10
      paymentReceiptPath: null,
    });
    expect(row?.animals).toEqual([
      { name: "Rex", type: "Dog", sex: "male", isFixed: "yes" },
    ]);
  });

  test("the fee is computed server-side — not fixed animals cost $100", async () => {
    const result = await createRegistrationSubmission(
      {
        ...VALID_SUBMISSION,
        submissionId: "22222222-2222-4333-8444-555555555555",
        animals: [{ name: "Kit", type: "Cat", sex: "female", isFixed: "no" }],
      },
      db,
    );
    expect(result.ok).toBe(true);
    const listed = await listRegistrationSubmissions(db);
    expect(
      listed.find((r) => r.id === "22222222-2222-4333-8444-555555555555")
        ?.totalFeeCents,
    ).toBe(10000);
  });

  test("a retried submission with the same id is idempotent, not a duplicate", async () => {
    const first = await createRegistrationSubmission(VALID_SUBMISSION, db);
    const second = await createRegistrationSubmission(VALID_SUBMISSION, db);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const listed = await listRegistrationSubmissions(db);
    expect(
      listed.filter((r) => r.id === VALID_SUBMISSION.submissionId),
    ).toHaveLength(1);
  });

  test("invalid payloads are rejected", async () => {
    expect(
      await createRegistrationSubmission(
        { ...VALID_SUBMISSION, submissionId: "not-a-uuid" },
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await createRegistrationSubmission(
        { ...VALID_SUBMISSION, ownerName: "" },
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await createRegistrationSubmission(
        {
          ...VALID_SUBMISSION,
          submissionId: "33333333-3333-4333-8444-555555555555",
          receiptPath: "receipts/../../etc/passwd",
        },
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("status transitions audit and set decidedAt; pending clears it", async () => {
    const created = await createRegistrationSubmission(
      {
        ...VALID_SUBMISSION,
        submissionId: "44444444-4444-4444-8444-555555555555",
      },
      db,
    );
    expect(created.ok).toBe(true);

    const approved = await updateSubmissionStatus(
      "44444444-4444-4444-8444-555555555555",
      "approved",
      "staff@test.dev",
      db,
    );
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.submission.status).toBe("approved");
      expect(approved.submission.decidedAt).not.toBeNull();
    }

    const reopened = await updateSubmissionStatus(
      "44444444-4444-4444-8444-555555555555",
      "pending",
      "staff@test.dev",
      db,
    );
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.submission.decidedAt).toBeNull();
    }

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(
        eq(
          schema.auditEvents.entityId,
          "44444444-4444-4444-8444-555555555555",
        ),
      );
    const statusAudits = audit.filter((a) => a.action === "status-change");
    expect(statusAudits).toHaveLength(2);
    // Audit rows carry status only — never owner PII.
    expect(JSON.stringify(statusAudits)).not.toContain("Jane");
  });

  test("invalid status and missing submissions are rejected", async () => {
    expect(
      await updateSubmissionStatus(
        "44444444-4444-4444-8444-555555555555",
        "shipped",
        "staff@test.dev",
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await updateSubmissionStatus(
        "99999999-9999-4999-8999-999999999999",
        "approved",
        "staff@test.dev",
        db,
      ),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  test("existence check feeds the receipt sweep", async () => {
    expect(
      await registrationSubmissionExists(VALID_SUBMISSION.submissionId, db),
    ).toBe(true);
    expect(
      await registrationSubmissionExists(
        "99999999-9999-4999-8999-999999999999",
        db,
      ),
    ).toBe(false);
    // Non-uuid object names can never match a submission.
    expect(await registrationSubmissionExists("bogus", db)).toBe(false);
  });
});

describe("admin_users authorization", () => {
  test("provision inserts once and matches email case-insensitively", async () => {
    await provisionAdminUser("Staff@Test.dev", db);
    await provisionAdminUser("staff@test.dev", db); // second call is a no-op

    const found = await findAdminUser("STAFF@test.dev", db);
    expect(found).toMatchObject({ role: "admin" });
    expect(found?.email).toBe("staff@test.dev");
  });

  test("findAdminUser returns null for unknown and empty emails", async () => {
    expect(await findAdminUser("nobody@test.dev", db)).toBeNull();
    expect(await findAdminUser("", db)).toBeNull();
  });
});
