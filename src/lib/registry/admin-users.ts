// Admin authorization seam (#183). admin_users is the authoritative
// record for who may administer the site; Firebase Auth remains the
// identity provider. Emails are matched case-insensitively — the
// lower(email) unique index guarantees the lookup is unambiguous.
//
// Boundary rules are the same as the rest of src/lib/registry/:
// server-only, DTOs out, explicit column lists.

import "server-only";

import { sql } from "drizzle-orm";
import { adminUsers } from "../db/schema";
import { getRegistryDb } from "../db/client";
import type { RegistryDb } from "./public-animals";

export type AdminRole = "admin" | "editor";

export interface AdminUserRecord {
  id: string;
  email: string;
  role: AdminRole;
}

const ADMIN_USER_COLUMNS = {
  id: adminUsers.id,
  email: adminUsers.email,
  role: adminUsers.role,
} as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findAdminUser(
  email: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AdminUserRecord | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const [row] = await db
    .select(ADMIN_USER_COLUMNS)
    .from(adminUsers)
    .where(sql`lower(${adminUsers.email}) = ${normalized}`)
    .limit(1);
  if (!row) return null;
  // The role CHECK constraint keeps this to admin|editor; the cast
  // trusts the constraint rather than re-validating every read.
  return { ...row, role: row.role as AdminRole };
}

// Bootstrap provisioning: called during session creation when an
// ADMIN_EMAILS-listed account authenticates. Inserts only — an existing
// row's role is staff-managed and is never rewritten by env config.
export async function provisionAdminUser(
  email: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AdminUserRecord | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  await db
    .insert(adminUsers)
    .values({ email: normalized, role: "admin" })
    .onConflictDoNothing();
  return findAdminUser(normalized, db);
}
