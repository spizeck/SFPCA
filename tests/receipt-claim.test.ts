// PGlite-backed tests for the receipt-upload claim primitive (#219
// review): the conditional UPDATE that entitles an upload. Exercises
// the real database guarantees — a claimed or undeclared submission
// cannot be re-claimed, concurrency resolves to exactly one winner,
// and release restores retryability.

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "@/lib/db/schema";
import { registrationSubmissions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  claimReceiptSlot,
  createRegistrationSubmission,
  listReceiptClaims,
  releaseReceiptSlot,
  submissionClaimsReceipt,
} from "@/lib/registry/registrations";
import type { RegistryDb } from "@/lib/registry/public-animals";

let pglite: PGlite;
let db: RegistryDb;

beforeAll(async () => {
  pglite = new PGlite();
  const pgliteDb: PgliteDatabase<typeof schema> = drizzle(pglite, { schema });
  await runMigrationsOnPglite(pgliteDb);
  db = pgliteDb as RegistryDb;
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

let seq = 0;
async function submission(receiptRequested = true) {
  seq += 1;
  const submissionId = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const r = await createRegistrationSubmission(
    {
      submissionId,
      receiptRequested,
      ownerName: "Jane Owner",
      ownerAddress: "Windwardside",
      ownerPhone: "+599 416 0000",
      ownerEmail: `claim-${seq}@example.com`,
      animals: [
        { name: "Rex", type: "Dog", sex: "male", isFixed: "yes" },
      ],
    },
    db,
  );
  expect(r.ok).toBe(true);
  return submissionId;
}

describe("claimReceiptSlot", () => {
  test("claims the receipt slot of a willing pending submission", async () => {
    const id = await submission(true);
    expect(await claimReceiptSlot(id, db)).toEqual({ ok: true });
    expect(await submissionClaimsReceipt(id, db)).toBe(true);
    const [row] = await (db as PgliteDatabase<typeof schema>)
      .select({ path: registrationSubmissions.paymentReceiptPath })
      .from(registrationSubmissions)
      .where(eq(registrationSubmissions.id, id));
    expect(row.path).toBe(`receipts/${id}`);
  });

  test("a second claim on the same submission cannot win", async () => {
    const id = await submission(true);
    expect(await claimReceiptSlot(id, db)).toEqual({ ok: true });
    expect(await claimReceiptSlot(id, db)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("concurrent claims resolve to exactly one winner", async () => {
    const id = await submission(true);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimReceiptSlot(id, db)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok && r.reason === "unavailable"),
    ).toHaveLength(4);
  });

  test("a submission that never requested a receipt is not claimable", async () => {
    const id = await submission(false);
    expect(await claimReceiptSlot(id, db)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await submissionClaimsReceipt(id, db)).toBe(false);
  });

  test("a nonexistent or malformed id is not claimable", async () => {
    expect(
      await claimReceiptSlot("99999999-9999-4999-8999-999999999999", db),
    ).toEqual({ ok: false, reason: "not-found" });
    expect(await claimReceiptSlot("../etc/passwd", db)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await claimReceiptSlot("a/b/c", db)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  test("a decided submission is not claimable", async () => {
    const id = await submission(true);
    await (db as PgliteDatabase<typeof schema>)
      .update(registrationSubmissions)
      .set({ status: "approved" })
      .where(eq(registrationSubmissions.id, id));
    expect(await claimReceiptSlot(id, db)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("release clears the claim so a retry can proceed", async () => {
    const id = await submission(true);
    expect(await claimReceiptSlot(id, db)).toEqual({ ok: true });
    await releaseReceiptSlot(id, db);
    expect(await submissionClaimsReceipt(id, db)).toBe(false);
    expect(await claimReceiptSlot(id, db)).toEqual({ ok: true });
  });

  test("listReceiptClaims reports only rows holding a claim", async () => {
    const withReceipt = await submission(true);
    const without = await submission(false);
    await claimReceiptSlot(withReceipt, db);
    const claims = await listReceiptClaims(db);
    const ids = claims.map((c) => c.id);
    expect(ids).toContain(withReceipt);
    expect(ids).not.toContain(without);
    expect(
      claims.find((c) => c.id === withReceipt)?.paymentReceiptPath,
    ).toBe(`receipts/${withReceipt}`);
  });
});
