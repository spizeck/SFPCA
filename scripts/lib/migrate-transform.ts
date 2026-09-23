// Pure Firestore→Postgres record transforms for the #181 import.
//
// Deliberately free of Firebase/Postgres imports so the exact production
// mapping is unit-testable with synthetic fixtures. Every function returns
// the destination row plus a list of data-quality exceptions — anomalies
// are surfaced, never silently normalized.
//
// Privacy: exception details describe field shapes/types only — never
// record values.

import { createHash } from "node:crypto";
import type { animals, adminUsers, registrationSubmissions } from "../../src/lib/db/schema";

export type AnimalInsert = typeof animals.$inferInsert;
export type AdminInsert = typeof adminUsers.$inferInsert;
export type SubmissionInsert = typeof registrationSubmissions.$inferInsert;

export type ExceptionKind =
  | "unsupported-status"
  | "unsupported-value"
  | "missing-field"
  | "invalid-timestamp"
  | "malformed-record"
  | "duplicate-legacy-id";

export interface MigrationException {
  collection: string;
  docId: string;
  kind: ExceptionKind;
  field: string;
  detail: string; // type/shape only — never a value
}

interface TransformResult<TRow> {
  row: TRow;
  exceptions: MigrationException[];
}

const KNOWN_ANIMAL_STATUSES = new Set(["available", "pending", "adopted"]);
const KNOWN_SPECIES = new Set(["dog", "cat", "other"]);
const KNOWN_SEXES = new Set(["male", "female", "unknown"]);
const KNOWN_REG_STATUSES = new Set(["pending", "approved", "rejected"]);
const KNOWN_ADMIN_ROLES = new Set(["admin", "editor"]);

type AnyDoc = Record<string, unknown>;

function exc(
  collection: string,
  docId: string,
  kind: ExceptionKind,
  field: string,
  detail: string,
): MigrationException {
  return { collection, docId, kind, field, detail };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Firestore Timestamp -> Date; returns undefined for anything else.
function ts(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (
    v &&
    typeof v === "object" &&
    typeof (v as { toDate?: unknown }).toDate === "function"
  ) {
    return (v as { toDate: () => Date }).toDate();
  }
  return undefined;
}

// --- animals ---------------------------------------------------------------

export function transformAnimal(
  docId: string,
  d: AnyDoc,
): TransformResult<AnimalInsert> {
  const exceptions: MigrationException[] = [];
  const c = "animals";

  const name = str(d.name);
  if (!name)
    exceptions.push(exc(c, docId, "missing-field", "name", `type=${typeof d.name}`));

  const speciesRaw = str(d.species);
  let species: string;
  if (!speciesRaw) {
    if (d.species !== undefined)
      exceptions.push(exc(c, docId, "missing-field", "species", `type=${typeof d.species}`));
    species = "other";
  } else if (!KNOWN_SPECIES.has(speciesRaw)) {
    exceptions.push(exc(c, docId, "unsupported-value", "species", "unrecognized value"));
    species = "other";
  } else {
    species = speciesRaw;
  }

  const sexRaw = str(d.sex);
  let sex = "unknown";
  if (sexRaw && !KNOWN_SEXES.has(sexRaw)) {
    exceptions.push(exc(c, docId, "unsupported-value", "sex", "unrecognized value"));
  } else if (sexRaw) {
    sex = sexRaw;
  } else if (d.sex !== undefined) {
    exceptions.push(exc(c, docId, "missing-field", "sex", `type=${typeof d.sex}`));
  }

  // Fail closed on the public boundary: unrecognized lifecycle imports
  // as private "pending", never "available" — and is always flagged.
  let status = str(d.status);
  if (!status || !KNOWN_ANIMAL_STATUSES.has(status)) {
    exceptions.push(
      exc(c, docId, "unsupported-status", "status", `type=${typeof d.status}`),
    );
    status = "pending";
  }

  let photoUrls: string[] = [];
  if (d.photos !== undefined) {
    if (Array.isArray(d.photos)) {
      const bad = d.photos.filter((p) => typeof p !== "string").length;
      if (bad > 0)
        exceptions.push(exc(c, docId, "malformed-record", "photos", `${bad} non-string element(s)`));
      photoUrls = d.photos.filter((p): p is string => typeof p === "string");
    } else {
      exceptions.push(exc(c, docId, "malformed-record", "photos", `type=${typeof d.photos}`));
    }
  }

  const created = ts(d.createdAt);
  const updated = ts(d.updatedAt);
  if (d.createdAt !== undefined && !created)
    exceptions.push(exc(c, docId, "invalid-timestamp", "createdAt", `type=${typeof d.createdAt}`));
  if (d.updatedAt !== undefined && !updated)
    exceptions.push(exc(c, docId, "invalid-timestamp", "updatedAt", `type=${typeof d.updatedAt}`));

  // createdAt/updatedAt: only set when the source has a real timestamp —
  // otherwise leave undefined so column defaults apply and the field is
  // excluded from field-level reconciliation.
  return {
    row: {
      legacyId: docId,
      name: name ?? "(unnamed)",
      species,
      sex,
      approxAge: str(d.approxAge) ?? null,
      description: str(d.description) ?? null,
      lifecycleStatus: status,
      photoUrls,
      ...(created ? { createdAt: created } : {}),
      ...(updated ? { updatedAt: updated } : {}),
    },
    exceptions,
  };
}

// --- admins -----------------------------------------------------------------

export function transformAdmin(
  docId: string,
  d: AnyDoc,
): TransformResult<AdminInsert> {
  const exceptions: MigrationException[] = [];
  const c = "admins";

  // Firestore admins are keyed by email (verified: doc.id === doc.email).
  const email = docId.trim().toLowerCase();
  if (!/@/.test(email))
    exceptions.push(exc(c, docId, "malformed-record", "email", "doc id is not email-shaped"));

  let role = str(d.role);
  if (!role || !KNOWN_ADMIN_ROLES.has(role)) {
    exceptions.push(exc(c, docId, "unsupported-value", "role", `type=${typeof d.role}`));
    role = "editor"; // least-privilege default for an unknown role
  }

  return { row: { email, role }, exceptions };
}

// --- animalRegistrations -> registration_submissions ------------------------

export function transformRegistration(
  docId: string,
  d: AnyDoc,
): TransformResult<SubmissionInsert> {
  const exceptions: MigrationException[] = [];
  const c = "animalRegistrations";

  const owner = (d.ownerInfo ?? {}) as AnyDoc;
  if (d.ownerInfo !== undefined && typeof d.ownerInfo !== "object")
    exceptions.push(exc(c, docId, "malformed-record", "ownerInfo", `type=${typeof d.ownerInfo}`));

  const ownerName = str(owner.name);
  if (!ownerName)
    exceptions.push(exc(c, docId, "missing-field", "ownerInfo.name", `type=${typeof owner.name}`));

  let status = str(d.status);
  if (!status || !KNOWN_REG_STATUSES.has(status)) {
    exceptions.push(exc(c, docId, "unsupported-status", "status", `type=${typeof d.status}`));
    status = "pending";
  }

  let totalFeeCents = 0;
  if (d.totalFee !== undefined) {
    if (typeof d.totalFee === "number" && Number.isFinite(d.totalFee)) {
      totalFeeCents = Math.round(d.totalFee * 100);
    } else {
      exceptions.push(exc(c, docId, "malformed-record", "totalFee", `type=${typeof d.totalFee}`));
    }
  }

  const created = ts(d.createdAt);
  const updated = ts(d.updatedAt);
  const decided = ts(d.decidedAt);
  for (const [f, raw, parsed] of [
    ["createdAt", d.createdAt, created],
    ["updatedAt", d.updatedAt, updated],
    ["decidedAt", d.decidedAt, decided],
  ] as const) {
    if (raw !== undefined && !parsed)
      exceptions.push(exc(c, docId, "invalid-timestamp", f, `type=${typeof raw}`));
  }
  if (created === undefined)
    exceptions.push(exc(c, docId, "missing-field", "createdAt", "absent — submittedAt left to default"));

  return {
    row: {
      legacyId: docId,
      ownerName: ownerName ?? "(unknown)",
      ownerAddress: str(owner.address) ?? null,
      ownerPhone: str(owner.phone) ?? null,
      ownerEmail: str(owner.email) ?? null,
      // Intake snapshot of the submitted animal list — carried verbatim
      // into the JSONB column; shape was enforced at intake time.
      animals: Array.isArray(d.animals) ? d.animals : null,
      paymentReceiptPath: str(d.paymentReceipt) ?? null,
      totalFeeCents,
      currency: "USD",
      status,
      // submittedAt mirrors createdAt (the intake event time); absent →
      // column default + exception above keeps reconciliation honest.
      ...(created ? { submittedAt: created, createdAt: created } : {}),
      ...(updated ? { updatedAt: updated } : {}),
      ...(decided ? { decidedAt: decided } : {}),
    },
    exceptions,
  };
}

// --- reconciliation projections --------------------------------------------
// A projection is the canonical, deterministic view of the fields the
// migration is responsible for. Comparing projections — not raw rows —
// is what proves semantic equivalence.

function canon(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canon);
  return v ?? null;
}

export function animalProjection(r: AnimalInsert): Record<string, unknown> {
  return {
    legacyId: r.legacyId,
    name: r.name,
    species: r.species,
    sex: r.sex,
    approxAge: canon(r.approxAge),
    description: canon(r.description),
    lifecycleStatus: r.lifecycleStatus,
    photoUrls: canon(r.photoUrls),
    ...(r.createdAt ? { createdAt: canon(r.createdAt) } : {}),
    ...(r.updatedAt ? { updatedAt: canon(r.updatedAt) } : {}),
  };
}

export function adminProjection(r: AdminInsert): Record<string, unknown> {
  return { email: r.email?.toLowerCase(), role: r.role };
}

export function submissionProjection(
  r: SubmissionInsert,
): Record<string, unknown> {
  return {
    legacyId: r.legacyId,
    ownerName: r.ownerName,
    ownerAddress: canon(r.ownerAddress),
    ownerPhone: canon(r.ownerPhone),
    ownerEmail: canon(r.ownerEmail),
    animals: canon(r.animals),
    paymentReceiptPath: canon(r.paymentReceiptPath),
    totalFeeCents: r.totalFeeCents,
    currency: r.currency,
    status: r.status,
    ...(r.submittedAt ? { submittedAt: canon(r.submittedAt) } : {}),
    ...(r.decidedAt ? { decidedAt: canon(r.decidedAt) } : {}),
    ...(r.createdAt ? { createdAt: canon(r.createdAt) } : {}),
    ...(r.updatedAt ? { updatedAt: canon(r.updatedAt) } : {}),
  };
}

// Stable hash of a projection — lets the operator verify equivalence
// without any field value appearing in output.
export function projectionHash(p: Record<string, unknown>): string {
  const stable = JSON.stringify(p, Object.keys(p).sort());
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

// Restrict a destination row to the keys an expected projection covers,
// canonicalized — column defaults (createdAt etc.) never cause false
// mismatches when the source lacked the field.
export function projectDestRow(
  row: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canon(row[k]);
  return out;
}

// Returns the field names whose values differ (never the values).
export function diffProjection(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): string[] {
  return Object.keys(expected).filter(
    (k) => JSON.stringify(canon(expected[k])) !== JSON.stringify(canon(actual[k])),
  );
}
