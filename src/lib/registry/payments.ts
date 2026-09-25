// Payment-side reads for the registrations ledger (#169 seam into
// #170's domain). The `payments` table is the provider-neutral ledger —
// provider flows, reconciliation, refunds and adjustments belong to
// #170; what lives here is the ONE shared projection every consumer
// needs: how much CONFIRMED money stands against a registration.
//
// Payment initiation is not payment truth: only status='confirmed' rows
// count. Registration payment state is always DERIVED from this plus
// the registration's own resolution — never stored, so it can never
// disagree with the ledger.

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { payments } from "../db/schema";
import type { RegistryDb } from "./public-animals";

// Net confirmed cents applied to each registration: payments and
// positive adjustments add, refunds subtract. Returns a Map so callers
// get O(1) lookup; registrations with no confirmed rows are absent
// (treat as 0).
export async function confirmedPaidByRegistration(
  db: Pick<RegistryDb, "select">,
  registrationIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (registrationIds.length === 0) return map;
  const rows = await db
    .select({
      registrationId: payments.registrationId,
      total: sql<number>`coalesce(sum(CASE WHEN ${payments.kind} = 'refund' THEN -${payments.amountCents} ELSE ${payments.amountCents} END), 0)::int`,
    })
    .from(payments)
    .where(
      and(
        inArray(payments.registrationId, registrationIds),
        eq(payments.status, "confirmed"),
      ),
    )
    .groupBy(payments.registrationId);
  for (const r of rows) {
    if (r.registrationId) map.set(r.registrationId, r.total);
  }
  return map;
}
