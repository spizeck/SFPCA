// Relational foundation for the animal-registry roadmap (#165).
//
// This schema is the Postgres target model for operational registry data.
// It deliberately does NOT model CMS content — homepage copy, FAQs, site
// settings, and page content stay in Firestore (see
// docs/architecture/persistence.md for the ownership boundary).
//
// Conventions:
// - snake_case column names; camelCase TS properties
// - uuid PKs defaulting to gen_random_uuid(); Firestore document IDs are
//   preserved in legacy_* columns so existing public URLs keep working
// - text + CHECK constraints for status enums (extensible via migration —
//   cheaper than pgEnum ALTER TYPE churn while lifecycle vocabulary is
//   still evolving)
// - timestamptz everywhere; money as integer cents + currency code
// - restrictive (default NO ACTION) deletes on historical/financial data

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();

// --- People & identity ----------------------------------------------------
// Domain Person records are separate from authentication identities:
// Firebase Auth proves WHO signed in; a Person is a registry entity an
// owner, contact, or staff member maps to. Most Persons will never have
// an auth identity (migrated records, offline owners).

export const persons = pgTable(
  "persons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    // Not unique — household members legitimately share an email address.
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    preferredChannel: text("preferred_channel"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("persons_email_idx").on(t.email),
    check(
      "persons_preferred_channel_check",
      sql`${t.preferredChannel} IS NULL OR ${t.preferredChannel} IN ('email','phone','whatsapp','sms')`,
    ),
  ],
);

// External authentication identities (Firebase Auth today). providerUid is
// the stable Firebase UID; a Person may have zero or more identities.
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerUid: text("provider_uid").notNull(),
    email: text("email"),
    personId: uuid("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auth_identities_provider_uid_key").on(
      t.provider,
      t.providerUid,
    ),
  ],
);

// Staff authorization — mirrors the Firestore `admins` collection
// (keyed by email, role admin|editor). Linked to an auth identity when
// the person signs in; personId links to the domain Person record.
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    authIdentityId: uuid("auth_identity_id").references(
      () => authIdentities.id,
      { onDelete: "set null" },
    ),
    personId: uuid("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("admin_users_email_key").on(sql`lower(${t.email})`),
    check("admin_users_role_check", sql`${t.role} IN ('admin','editor')`),
  ],
);

// --- Households -----------------------------------------------------------
// A household groups people and animals without assuming
// "one login = one owner = one animal".

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  address: text("address"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.personId] }),
    check(
      "household_members_role_check",
      sql`${t.role} IN ('member','primary')`,
    ),
  ],
);

// --- Animals --------------------------------------------------------------
// Permanent durable identity (#167). The animal row is the registry's
// source of truth for an animal known to SFPCA — it exists independently
// of any owner, registration, payment, vet visit, vaccination, or portal
// account, and is never deleted just because no current registration
// exists. Annual registration and payment state are deliberately NOT
// columns here.
//
// Two deliberately separate status concepts live on the row:
//   - lifecycleStatus — the REGISTRY reality (src/lib/animal-lifecycle.ts):
//     'active' (living on Saba / in registry care), 'deceased',
//     'moved-off-saba', 'unknown' (on-island/living status unconfirmed).
//     Mutated only through transitionAnimalLifecycle — every change is a
//     row in animal_lifecycle_events, never a silent overwrite.
//   - adoptionStatus — the public adoption-catalog state
//     ('not-listed','available','pending','adopted'): whether the animal
//     appears on the public site. Publication requires BOTH
//     adoption_status='available' AND lifecycle_status='active'.
//
// Birth data avoids false precision: birth_date is null when unknown;
// birth_date_estimated=true marks an approximate date ("about 2 years"
// entered as an estimated birth date). Neither is ever required.
//
// Sterilization: sterilization_status is the current registry fact
// ('unknown'|'sterilized'|'intact'); vet_procedures spay/neuter rows are
// the authoritative EVIDENCE — recording one marks the animal sterilized
// and backfills date/provider when empty (see registry/medical.ts).
// The animal columns exist so historical knowledge ("was already spayed,
// no record of where") never requires a fabricated procedure.
//
// registry_ref is the permanent human-readable reference (SFPCA-000001),
// assigned by sequence at insert and never reused or rewritten — staff
// search and owner conversations use it; the uuid stays the identity key.
// photo_urls are public listing photo URLs only (admin-entered; rendered
// publicly only while the animal is published); private media and
// clinical documents live under vet-docs/ via vet_documents, never here.

export const animals = pgTable(
  "animals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Firestore document ID — keeps /animal-adoptions/[id] URLs stable
    // across migration. Null for Postgres-native records.
    legacyId: text("legacy_id"),
    registryRef: text("registry_ref")
      .notNull()
      .default(
        sql`'SFPCA-' || lpad(nextval('animal_registry_ref_seq'::regclass)::text, 6, '0')`,
      ),
    name: text("name").notNull(),
    species: text("species").notNull(),
    sex: text("sex").notNull(),
    birthDate: date("birth_date", { mode: "string" }),
    birthDateEstimated: boolean("birth_date_estimated")
      .notNull()
      .default(false),
    // Public-safe listing copy — rendered on the public site when the
    // animal is published.
    description: text("description"),
    // Staff-only identifying detail (markings, scars, distinguishing
    // features) — never part of public DTOs.
    identifyingNotes: text("identifying_notes"),
    lifecycleStatus: text("lifecycle_status").notNull().default("active"),
    // The date the current lifecycle state became effective — null when
    // unknown (e.g. pre-registry history).
    lifecycleEffectiveOn: date("lifecycle_effective_on", { mode: "string" }),
    adoptionStatus: text("adoption_status").notNull().default("not-listed"),
    sterilizationStatus: text("sterilization_status")
      .notNull()
      .default("unknown"),
    sterilizedOn: date("sterilized_on", { mode: "string" }),
    sterilizedBy: text("sterilized_by"),
    photoUrls: text("photo_urls").array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("animals_legacy_id_key").on(t.legacyId),
    uniqueIndex("animals_registry_ref_key").on(t.registryRef),
    index("animals_lifecycle_status_idx").on(t.lifecycleStatus),
    index("animals_adoption_status_idx").on(t.adoptionStatus),
    check(
      "animals_species_check",
      sql`${t.species} IN ('dog','cat','other')`,
    ),
    check("animals_sex_check", sql`${t.sex} IN ('male','female','unknown')`),
    check(
      "animals_lifecycle_status_check",
      sql`${t.lifecycleStatus} IN ('active','deceased','moved-off-saba','unknown')`,
    ),
    check(
      "animals_adoption_status_check",
      sql`${t.adoptionStatus} IN ('not-listed','available','pending','adopted')`,
    ),
    check(
      "animals_sterilization_status_check",
      sql`${t.sterilizationStatus} IN ('unknown','sterilized','intact')`,
    ),
    check(
      "animals_birth_estimate_consistency_check",
      sql`${t.birthDateEstimated} = false OR ${t.birthDate} IS NOT NULL`,
    ),
  ],
);

// Lifecycle transition history (#167) — the durable record of every
// registry-state change an animal has gone through. A row is written by
// transitionAnimalLifecycle in the same transaction as the status flip;
// animals.lifecycle_status stays the efficiently-queryable current state
// while this table preserves WHY and WHEN it changed. from_status is
// null only on the initial "entered the registry" event recorded at
// animal creation. This is DOMAIN history — audit_events remains the
// actor/change audit; the two are not interchangeable.
export const animalLifecycleEvents = pgTable(
  "animal_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — registry history
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    // The date the new state became effective in the real world — may
    // be earlier than created_at when a report is confirmed late.
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),
    // Bounded provenance: what kind of action produced the transition.
    source: text("source").notNull(),
    // Loose reference for the source — the owner_requests id for
    // 'owner-request' transitions; null otherwise.
    sourceRef: text("source_ref"),
    reason: text("reason"),
    actorIdentityId: uuid("actor_identity_id").references(
      () => authIdentities.id,
      { onDelete: "set null" },
    ),
    actorLabel: text("actor_label"),
    createdAt: createdAt(),
  },
  (t) => [
    index("animal_lifecycle_events_animal_idx").on(t.animalId, t.effectiveOn),
    check(
      "animal_lifecycle_events_from_status_check",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} IN ('active','deceased','moved-off-saba','unknown')`,
    ),
    check(
      "animal_lifecycle_events_to_status_check",
      sql`${t.toStatus} IN ('active','deceased','moved-off-saba','unknown')`,
    ),
    check(
      "animal_lifecycle_events_source_check",
      sql`${t.source} IN ('staff','owner-request','import')`,
    ),
  ],
);

// Historical ownership — animal ↔ person OR household. Never rewritten:
// an ownership change closes validTo on the old row and opens a new one.
// Intervals are [valid_from, valid_to): an open-ended valid_to is "still
// current", and valid_to is the first day the relationship no longer
// holds. Multiple simultaneously-valid rows are legitimate co-ownership
// (e.g. two partners each recorded) — the canonical projections in
// src/lib/registry/ownership.ts pick deterministically for display and
// fail closed on ambiguity where guessing would be wrong (reminder
// sends). note is staff context for why the interval exists ("transfer
// approved via owner request", "registration import") — attribution
// lives in audit_events.
export const ownerships = pgTable(
  "ownerships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive delete — history
    personId: uuid("person_id").references(() => persons.id),
    householdId: uuid("household_id").references(() => households.id),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ownerships_animal_idx").on(t.animalId),
    // The owner-portal hot reads: "my animals" by person, and by every
    // household the person belongs to.
    index("ownerships_person_idx").on(t.personId),
    index("ownerships_household_idx").on(t.householdId),
    check(
      "ownerships_one_owner_side_check",
      sql`num_nonnulls(${t.personId}, ${t.householdId}) = 1`,
    ),
    check(
      "ownerships_valid_range_check",
      sql`${t.validTo} IS NULL OR ${t.validTo} > ${t.validFrom}`,
    ),
  ],
);

// Annual ownership confirmations (#166) — append-only evidence that a
// person explicitly affirmed "this animal is still living on Saba and
// associated with me". A row is an EVENT, not mutable state: the
// relationship's last-confirmed date is MAX(confirmed_on) and history
// is never rewritten. person_id is the confirmed owner (for household
// ownerships, the member who attested); confirmed_by_identity_id is the
// authenticated account that submitted it (null for staff-recorded or
// imported confirmations). animal_id is denormalized from the ownership
// (immutable) so per-animal history reads don't re-join.
export const ownershipConfirmations = pgTable(
  "ownership_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownershipId: uuid("ownership_id")
      .notNull()
      .references(() => ownerships.id), // restrictive — evidence of the relationship
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — history
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id), // restrictive — history
    confirmedByIdentityId: uuid("confirmed_by_identity_id").references(
      () => authIdentities.id,
      { onDelete: "set null" },
    ),
    confirmedOn: date("confirmed_on", { mode: "string" })
      .notNull()
      .defaultNow(),
    method: text("method").notNull(),
    // Staff display label when method='staff' ("volunteer Maria at
    // clinic") — the owner-portal path leaves it null because the
    // identity link is the attribution.
    actorLabel: text("actor_label"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ownership_confirmations_ownership_idx").on(t.ownershipId),
    index("ownership_confirmations_animal_idx").on(t.animalId),
    index("ownership_confirmations_confirmed_idx").on(t.confirmedOn),
    check(
      "ownership_confirmations_method_check",
      sql`${t.method} IN ('owner-portal','staff')`,
    ),
  ],
);

// Owner-originated requests (#166) — the durable record of everything an
// owner asks the registry to change, plus the staff decision. Portal
// actions never mutate ownership/identity/lifecycle directly for
// high-impact or ambiguous changes: they write a 'pending' row here and
// staff resolve it. This is the canonical owner/registry exception query
// #177's dashboard should compose.
//
// Kind semantics:
//   'account-claim'            — a verified login claims an existing
//                                person record; person_id is null until
//                                staff pick the person at resolution
//                                (payload.candidatePersonIds lists the
//                                email-matched possibilities)
//   'no-longer-mine'           — owner reports the animal left their
//                                care; new owner unknown
//   'transfer'                 — owner names a new owner (payload carries
//                                the free-text target contact — never
//                                auto-resolved into a link)
//   'lifecycle-deceased'       — owner reports the animal died
//   'lifecycle-moved-off-saba' — owner reports the animal left Saba
//
// For the animal-scoped kinds, person_id is the reporting owner,
// ownership_id the relationship acted on, animal_id the animal. For
// 'account-claim', auth_identity_id is the claiming account and
// person_id is filled in with the linked person on approval.
export const ownerRequests = pgTable(
  "owner_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    authIdentityId: uuid("auth_identity_id").references(
      () => authIdentities.id,
      { onDelete: "set null" },
    ),
    personId: uuid("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    animalId: uuid("animal_id").references(() => animals.id, {
      onDelete: "set null",
    }),
    ownershipId: uuid("ownership_id").references(() => ownerships.id, {
      onDelete: "set null",
    }),
    // The submitter's bounded free-text detail ("moved to a farm in
    // May", "gave her to my cousin"). Never trusted as fact — staff
    // verify at resolution.
    detail: text("detail"),
    // Structured extras per kind — transfer target contact,
    // claim candidates, reported effective date.
    payload: jsonb("payload"),
    status: text("status").notNull().default("pending"),
    resolutionNote: text("resolution_note"),
    // Staff display label of the resolver (audit_events carries the
    // identity link; this keeps the row readable on its own).
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The staff queue hot read: pending work, oldest first.
    index("owner_requests_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index("owner_requests_person_idx").on(t.personId),
    index("owner_requests_animal_idx").on(t.animalId),
    index("owner_requests_identity_idx").on(t.authIdentityId),
    // One pending request per (account, kind, animal) — a resubmission
    // of "no longer mine" while the first is still open is a duplicate,
    // not a second work item. COALESCE keeps nulls comparable.
    uniqueIndex("owner_requests_pending_dedup")
      .on(
        t.authIdentityId,
        t.kind,
        sql`coalesce(${t.animalId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.status} = 'pending'`),
    check(
      "owner_requests_kind_check",
      sql`${t.kind} IN ('account-claim','no-longer-mine','transfer','lifecycle-deceased','lifecycle-moved-off-saba')`,
    ),
    check(
      "owner_requests_status_check",
      sql`${t.status} IN ('pending','approved','rejected','cancelled')`,
    ),
    // resolved_at is set exactly when the row leaves 'pending' — same
    // consistency rule as follow_ups/clinic_expectations.
    check(
      "owner_requests_resolved_consistency_check",
      sql`(${t.status} = 'pending') = (${t.resolvedAt} IS NULL)`,
    ),
  ],
);

// --- Registrations & payments ---------------------------------------------
// A submission is the intake event (what the public form writes today as
// animalRegistrations/*). Registrations are the per-animal per-year
// registry records the roadmap needs — a submission creates one or more.

export const registrationSubmissions = pgTable(
  "registration_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legacyId: text("legacy_id"), // Firestore animalRegistrations doc id
    // Submitter contact snapshot — the submitter is not necessarily a
    // domain Person yet; staff link one during verification.
    ownerName: text("owner_name").notNull(),
    ownerAddress: text("owner_address"),
    ownerPhone: text("owner_phone"),
    ownerEmail: text("owner_email"),
    // Intake snapshot of the animals submitted with the registration.
    // JSONB copy of the validated intake payload rather than a
    // normalized relation: these are the applicant's claims at
    // submission time, not registry animals — identity/animal linking
    // belongs to the later review workflow (#178).
    animals: jsonb("animals"),
    personId: uuid("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    // Firebase Storage object path (receipts/<id>) — a reference, never
    // the object itself; binary data does not live in Postgres.
    paymentReceiptPath: text("payment_receipt_path"),
    totalFeeCents: integer("total_fee_cents").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    status: text("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("registration_submissions_legacy_id_key").on(t.legacyId),
    check(
      "registration_submissions_status_check",
      sql`${t.status} IN ('pending','approved','rejected')`,
    ),
    check(
      "registration_submissions_fee_check",
      sql`${t.totalFeeCents} >= 0`,
    ),
  ],
);

export const registrations = pgTable(
  "registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — historical record
    submissionId: uuid("submission_id").references(
      () => registrationSubmissions.id,
      { onDelete: "set null" },
    ),
    year: integer("year").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("registrations_animal_year_key").on(t.animalId, t.year),
    index("registrations_submission_idx").on(t.submissionId),
    check("registrations_year_check", sql`${t.year} BETWEEN 2000 AND 2200`),
    check(
      "registrations_status_check",
      sql`${t.status} IN ('pending','approved','rejected')`,
    ),
  ],
);

// Provider-neutral ledger. Sentoo is one future provider value — nothing
// Sentoo-specific is foundational here. Deletes are never cascaded:
// financial history is append-only.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id").references(
      () => registrations.id,
    ),
    submissionId: uuid("submission_id").references(
      () => registrationSubmissions.id,
    ),
    personId: uuid("person_id").references(() => persons.id),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    kind: text("kind").notNull().default("payment"),
    status: text("status").notNull().default("pending"),
    provider: text("provider"),
    providerRef: text("provider_ref"),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payments_registration_idx").on(t.registrationId),
    index("payments_person_idx").on(t.personId),
    check("payments_kind_check", sql`${t.kind} IN ('payment','refund','adjustment')`),
    check(
      "payments_status_check",
      sql`${t.status} IN ('pending','confirmed','failed','void')`,
    ),
  ],
);

// --- Animal health ----------------------------------------------------------

// Normalized chip identity with assignment history — one ACTIVE
// assignment per chip number is enforced by the partial unique index;
// reassignment closes the previous row's assignedTo.
export const microchipRecords = pgTable(
  "microchip_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Normalized app-side before write: uppercase, non-alphanumerics stripped.
    chipNumber: text("chip_number").notNull(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id),
    assignedFrom: date("assigned_from", { mode: "string" })
      .notNull()
      .defaultNow(),
    assignedTo: date("assigned_to", { mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("microchip_active_chip_key")
      .on(t.chipNumber)
      .where(sql`${t.assignedTo} IS NULL`),
    index("microchip_animal_idx").on(t.animalId),
    check(
      "microchip_assignment_range_check",
      sql`${t.assignedTo} IS NULL OR ${t.assignedTo} >= ${t.assignedFrom}`,
    ),
  ],
);

// NOTE: vet_events was dropped in migration 0005 — vet_encounters
// (kind 'history'/'note') absorbed its standalone-history role, and
// structured records live in vaccinations/procedures/medications/
// alerts/weights. There is intentionally no second "loose event" table:
// two parallel models would leave it ambiguous where a fact belongs.
//
// Veterinary encounters (#174) — the hub of the continuity record.
// `kind` deliberately absorbs what vet_events used to cover, so there
// is ONE dated clinical-record model, not two competing ones:
//   'visit'   — an actual consultation/exam (provider, reason, exam notes)
//   'history' — a recorded past fact or claim ("owner reports spay
//               ~2021 at another clinic") with no SFPCA visit
//   'note'    — a standalone clinical note not tied to a visit
// Text fields stay free text on purpose — concise fields for volunteers,
// not a SOAP/EMR field-explosion. Structured data that must be queried
// (vaccinations, weights, alerts, procedures, medications) lives in its
// own table and links back via encounter_id.
export const vetEncounters = pgTable(
  "vet_encounters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    kind: text("kind").notNull().default("visit"),
    // The visit date, or the date a history/note entry applies to
    // (approximate past dates live in notes when fuzzy).
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    // Free-text provider: rotating/visiting vets are not registry
    // persons — attribution must survive access changes, so no FK.
    provider: text("provider"),
    // Why the animal was seen; the service requires it for 'visit'.
    reason: text("reason"),
    // Presenting complaint / concise history.
    complaint: text("complaint"),
    findings: text("findings"), // examination findings
    assessment: text("assessment"), // diagnosis/assessment
    plan: text("plan"), // treatment plan
    notes: text("notes"), // anything else
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vet_encounters_animal_idx").on(t.animalId, t.occurredOn),
    check(
      "vet_encounters_kind_check",
      sql`${t.kind} IN ('visit','history','note')`,
    ),
  ],
);

// Significant treatments/procedures (#174). `kind` carries the
// structured vocabulary — 'spay'/'neuter' rows are the authoritative
// EVIDENCE for sterilization: writing one marks
// animals.sterilization_status='sterilized' and backfills empty
// date/provider fields (registry/medical.ts). The animal columns exist
// separately because historical knowledge ("already spayed, no record
// of where") must not require a fabricated procedure row.
// performed_on is nullable because historical procedures often have no
// known date ("was already spayed at intake"); the approximation lives
// in notes.
export const vetProcedures = pgTable(
  "vet_procedures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    // The encounter it happened during — null for standalone/historical
    // records. Restrictive: deleting an encounter must not erase the
    // procedure fact.
    encounterId: uuid("encounter_id").references(() => vetEncounters.id),
    kind: text("kind").notNull(),
    performedOn: date("performed_on", { mode: "string" }),
    provider: text("provider"),
    description: text("description").notNull(),
    notes: text("notes"), // outcome, complications
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vet_procedures_animal_idx").on(t.animalId, t.performedOn),
    index("vet_procedures_encounter_idx").on(t.encounterId),
    check(
      "vet_procedures_kind_check",
      sql`${t.kind} IN ('spay','neuter','surgery','dental','wound','other')`,
    ),
  ],
);

// Medication/treatment history (#174) — "what meds matter", not
// prescribing infrastructure (no dispensing, refills, or pharmacy
// state). Active = derived: start_on <= today AND (end_on IS NULL OR
// end_on >= today) — never a stored status that goes stale.
export const vetMedications = pgTable(
  "vet_medications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    encounterId: uuid("encounter_id").references(() => vetEncounters.id),
    medication: text("medication").notNull(),
    dose: text("dose"), // e.g. "10 mg", "0.5 ml" — display text
    route: text("route"), // e.g. oral, topical, injectable
    frequency: text("frequency"), // e.g. "BID", "once daily"
    startOn: date("start_on", { mode: "string" }).notNull(),
    endOn: date("end_on", { mode: "string" }), // null = ongoing
    instructions: text("instructions"), // with food, taper, etc.
    prescribedBy: text("prescribed_by"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vet_medications_animal_idx").on(t.animalId, t.startOn),
    index("vet_medications_encounter_idx").on(t.encounterId),
    check(
      "vet_medications_range_check",
      sql`${t.endOn} IS NULL OR ${t.endOn} >= ${t.startOn}`,
    ),
  ],
);

// Medical alerts / important conditions (#174) — allergies,
// contraindications, chronic conditions. These must surface prominently
// on the animal record and never get buried inside old encounter text,
// so they are a first-class table with an explicit active/resolved
// lifecycle (resolve = set resolved_on, not delete — history survives).
export const medicalAlerts = pgTable(
  "medical_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    encounterId: uuid("encounter_id").references(() => vetEncounters.id),
    kind: text("kind").notNull(),
    severity: text("severity").notNull().default("important"),
    // The alert itself: "Penicillin allergy", "Grade III heart murmur".
    summary: text("summary").notNull(),
    details: text("details"),
    status: text("status").notNull().default("active"),
    recordedOn: date("recorded_on", { mode: "string" }).notNull(),
    resolvedOn: date("resolved_on", { mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("medical_alerts_animal_idx").on(t.animalId),
    // The hot read path: active alerts per animal (banner) and the
    // cross-animal "active alerts" scan (#175 work queue).
    index("medical_alerts_active_idx")
      .on(t.animalId)
      .where(sql`${t.status} = 'active'`),
    check(
      "medical_alerts_kind_check",
      sql`${t.kind} IN ('allergy','contraindication','condition','other')`,
    ),
    check(
      "medical_alerts_severity_check",
      sql`${t.severity} IN ('info','important','critical')`,
    ),
    check(
      "medical_alerts_status_check",
      sql`${t.status} IN ('active','resolved')`,
    ),
    // resolved_on is set exactly when status is 'resolved'.
    check(
      "medical_alerts_resolved_consistency_check",
      sql`(${t.status} = 'resolved') = (${t.resolvedOn} IS NOT NULL)`,
    ),
    check(
      "medical_alerts_resolved_range_check",
      sql`${t.resolvedOn} IS NULL OR ${t.resolvedOn} >= ${t.recordedOn}`,
    ),
  ],
);

// Weight history (#174) — longitudinal, queryable. weight_grams is an
// integer count of grams so the unit can never be ambiguous; the UI
// converts kg/lb on entry and formats on display.
export const weightRecords = pgTable(
  "weight_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    encounterId: uuid("encounter_id").references(() => vetEncounters.id),
    measuredOn: date("measured_on", { mode: "string" }).notNull(),
    weightGrams: integer("weight_grams").notNull(),
    notes: text("notes"), // e.g. body-condition score, "post-spay"
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("weight_records_animal_idx").on(t.animalId, t.measuredOn),
    index("weight_records_encounter_idx").on(t.encounterId),
    // >0 is the real invariant; the upper bound only catches typos —
    // 200 kg covers any plausible patient.
    check(
      "weight_records_grams_check",
      sql`${t.weightGrams} > 0 AND ${t.weightGrams} <= 200000`,
    ),
  ],
);

// Clinical document references (#174) — lab reports, certificates,
// referral letters. Only the Storage object path is stored (like
// payment_receipt_path / vaccinations.document_path); the uploader and
// the vet-docs/* Storage rules are deferred — this table establishes
// the relational shape so later work doesn't remodel.
export const vetDocuments = pgTable(
  "vet_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    encounterId: uuid("encounter_id").references(() => vetEncounters.id),
    vaccinationId: uuid("vaccination_id").references(() => vaccinations.id),
    storagePath: text("storage_path").notNull(),
    label: text("label").notNull(),
    notes: text("notes"),
    uploadedBy: text("uploaded_by"), // actor label snapshot
    createdAt: createdAt(),
  },
  (t) => [
    index("vet_documents_animal_idx").on(t.animalId),
    index("vet_documents_encounter_idx").on(t.encounterId),
    check(
      "vet_documents_path_check",
      sql`${t.storagePath} ~ '^vet-docs/'`,
    ),
  ],
);

// Structured vaccination history (#173) — the queryable record that
// drives due/overdue derivation and the reminder foundation (#172).
// Deliberately normalized: vaccine, dates, lot, and provider are queried
// structurally, so they are columns rather than details jsonb.
//
// Date semantics are distinct and all dates are stored facts:
// - administered_on — when THIS dose was given (historical fact)
// - due_on — recommended next-dose/revaccination date (drives reminders)
// - valid_until — legal/clinical expiry of this dose (e.g. rabies
//   certificate expiry). May differ from due_on.
// The effective "next relevant date" is derived as the earliest of
// due_on/valid_until — never a stored status that could go stale.
//
// series_key is the stable identity of a vaccine SERIES: a normalized
// form of vaccine_name (lowercase, non-alphanumerics stripped) computed
// by Postgres itself so every writer — the service, a backfill script,
// raw SQL — derives the same key. It exists so the due/reminder query
// can evaluate only the latest dose per (animal, series): a newer
// booster supersedes an older dose without deleting history. It is NOT
// a clinical vaccine ontology — a misspelled name forms its own series
// until the name is corrected, which re-derives the key automatically.
//
// encounter_id optionally ties a dose to the visit where it was given
// (#174); it stays nullable because vaccinations legitimately have no
// encounter (historical backfill, external clinic records).
export const vaccinations = pgTable(
  "vaccinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    encounterId: uuid("encounter_id").references(() => vetEncounters.id),
    vaccineName: text("vaccine_name").notNull(),
    seriesKey: text("series_key")
      .notNull()
      .generatedAlwaysAs(
        sql`lower(regexp_replace("vaccine_name", '[^a-zA-Z0-9]+', '', 'g'))`,
      ),
    administeredOn: date("administered_on", { mode: "string" }).notNull(),
    dueOn: date("due_on", { mode: "string" }),
    validUntil: date("valid_until", { mode: "string" }),
    productName: text("product_name"),
    manufacturer: text("manufacturer"),
    lotNumber: text("lot_number"),
    // Free-text provider: visiting/rotating vets are not registry
    // persons, and forcing a persons row per vet would be wrong.
    administeredBy: text("administered_by"),
    notes: text("notes"),
    // Storage object path for a certificate/record (vet-docs/...) —
    // a reference like payment_receipt_path, never the object itself.
    // Upload UI is a later issue; the column exists so the model is
    // complete without a rewrite.
    documentPath: text("document_path"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vaccinations_animal_idx").on(t.animalId),
    index("vaccinations_due_idx").on(t.dueOn),
    // Latest-dose-per-series reads: DISTINCT ON (animal_id, series_key).
    index("vaccinations_series_idx").on(t.animalId, t.seriesKey),
    check(
      "vaccinations_due_range_check",
      sql`${t.dueOn} IS NULL OR ${t.dueOn} >= ${t.administeredOn}`,
    ),
    check(
      "vaccinations_valid_range_check",
      sql`${t.validUntil} IS NULL OR ${t.validUntil} >= ${t.administeredOn}`,
    ),
  ],
);

// --- Operational queues -----------------------------------------------------

// Follow-up / recheck queue (#175). Encounters create 'recheck' rows
// here (#174 seam) — this is the one due-date system, not a parallel
// one. personId snapshots the current owner at creation time so the
// queue knows who to reach without re-deriving ownership.
//
// State model: 'open' is the only live status; 'completed'/'cancelled'
// are terminal and stamp resolved_at (enforced by the consistency
// CHECK). Time-relative state — upcoming / due / overdue — is DERIVED
// from due_on vs today by followUpState() in src/lib/medical.ts, never
// stored, so a row can never silently go stale. There is no delete path
// in the domain service: completing or cancelling preserves the full
// record and the audit_events trail.
export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id").references(() => animals.id, {
      onDelete: "set null",
    }),
    personId: uuid("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    registrationId: uuid("registration_id").references(
      () => registrations.id,
      { onDelete: "set null" },
    ),
    // Originating encounter (#174) — set null so closing/removing a
    // visit record never erases an open recheck.
    encounterId: uuid("encounter_id").references(() => vetEncounters.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    // Why the item is on the list ("suture removal", "recheck limp") —
    // the headline the queue renders. notes carries extra detail.
    reason: text("reason"),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    status: text("status").notNull().default("open"),
    notes: text("notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("follow_ups_due_idx").on(t.dueOn),
    // Per-animal open follow-ups — the medical record reads these.
    index("follow_ups_animal_idx").on(t.animalId),
    // The work-queue hot read: open items ordered by due date.
    index("follow_ups_open_due_idx")
      .on(t.dueOn)
      .where(sql`${t.status} = 'open'`),
    check(
      "follow_ups_status_check",
      sql`${t.status} IN ('open','completed','cancelled')`,
    ),
    // resolved_at is set exactly when the row leaves 'open' — mirrors
    // the medical_alerts resolved_on consistency rule.
    check(
      "follow_ups_resolved_consistency_check",
      sql`(${t.status} = 'open') = (${t.resolvedAt} IS NULL)`,
    ),
  ],
);

// Expected clinic animals (#194) — "this animal is expected at the
// clinic on this date, for this reason." Scheduling intent for
// periodic/part-time vet coverage, NOT a medical recheck (follow_ups)
// and NOT a visit that already happened (vet_encounters). The
// encounter_id link is optional and set only when marking the animal
// seen: it records which real visit fulfilled the expectation without
// manufacturing clinical facts — an animal can be seen with no
// encounter logged yet.
//
// State model mirrors follow_ups: 'expected' is the only live status;
// 'seen'/'no_show'/'cancelled' are terminal and stamp resolved_at
// (enforced by the consistency CHECK). Past-today/future urgency is
// DERIVED from expected_on by clinicExpectationState() — never stored.
// There is no delete path; expectations are history and survive
// resolution and ownership changes.
export const clinicExpectations = pgTable(
  "clinic_expectations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — clinic history
    personId: uuid("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    // The visit that fulfilled the expectation — set at mark-seen only.
    // set null so removing a visit record never erases the expectation.
    encounterId: uuid("encounter_id").references(() => vetEncounters.id, {
      onDelete: "set null",
    }),
    expectedOn: date("expected_on", { mode: "string" }).notNull(),
    // Optional free-text session hint ("Saturday AM clinic") — a label,
    // not a slot. No appointment times live here.
    sessionLabel: text("session_label"),
    // Why the animal is coming ("vaccination visit") — the queue
    // headline, required so a row never reads as a bare date.
    reason: text("reason").notNull(),
    status: text("status").notNull().default("expected"),
    notes: text("notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("clinic_expectations_animal_idx").on(t.animalId),
    // The queue hot read: unresolved expectations ordered by date.
    index("clinic_expectations_expected_idx")
      .on(t.expectedOn)
      .where(sql`${t.status} = 'expected'`),
    check(
      "clinic_expectations_status_check",
      sql`${t.status} IN ('expected','seen','no_show','cancelled')`,
    ),
    // resolved_at is set exactly when the row leaves 'expected' —
    // same consistency rule as follow_ups.
    check(
      "clinic_expectations_resolved_consistency_check",
      sql`(${t.status} = 'expected') = (${t.resolvedAt} IS NULL)`,
    ),
  ],
);

// Outbound communication / reminder ledger + send log (#172). This is
// the ONE communications table — eligibility evaluators register intent
// here, the delivery drain owns provider interaction, and webhooks
// refine delivery state. The database row, not provider logs, is
// authoritative for whether a message was queued/sent/failed.
//
// State machine:
//   queued    — intent recorded, awaiting a delivery attempt
//   sending   — claimed by a drain pass; transient between claim and
//               provider outcome (a crash leaves a stale row the next
//               pass reclaims as 'failed'/'interrupted' — an uncertain
//               send is never blindly retried)
//   sent      — provider accepted the message
//   delivered — provider confirmed delivery (webhook; terminal success)
//   failed    — terminal for automation: definite rejection, provider
//               failure past the retry bound, bounce/complaint, or an
//               interrupted send whose delivery is uncertain. Staff
//               may requeue after checking the provider console.
//   skipped   — evaluated but deliberately not sent (no resolvable
//               recipient, opt-out, ...); `detail` carries the reason
//
// idempotency_key is the deterministic identity of a logical send —
// <prefix>:<relatedId>:<cycleKey>:<touch> — so retries, duplicate cron
// runs, and manual re-evaluation can never create a second row for the
// same reminder. cycle_key scopes a reminder "cycle" (a vaccination's
// current due date, a registration year, ...) so a changed due date
// starts fresh touches while history stays attributable.
//
// Snapshots: recipient/subject/body_text capture what was actually
// addressed and said, so history can be reconstructed even after the
// person or ownership records change. person_id is nullable because an
// evaluated reminder may have no resolvable person — that fact is
// itself an exception worth recording.
export const communications = pgTable(
  "communications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").references(() => persons.id),
    // The animal this message concerns — a denormalized shortcut so
    // staff surfaces and per-animal history don't re-derive it from
    // the loose related_type/related_id reference. Nullable: not every
    // communication is about an animal.
    animalId: uuid("animal_id").references(() => animals.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key"),
    // Loose entity reference (e.g. "registration", uuid string) — any
    // domain entity may drive a message without a rigid FK web.
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    // The logical event this send belongs to (e.g. a vaccination's
    // effective due date) and which numbered notice it is within the
    // cycle ('reminder-1', 'reminder-2', ...). Exception/skip rows use
    // 'skip:<reason>' so they never consume a send touch.
    cycleKey: text("cycle_key"),
    touch: text("touch"),
    // Send-time snapshots — the record of what was actually sent even
    // after contact details change.
    recipient: text("recipient"),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    // Provider bookkeeping: which sender, its message id (webhook
    // correlation), attempt count/timing, and the delivery timestamp
    // a webhook stamped. sent_at stays "provider accepted".
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Bounded machine-readable reason for skipped/failed outcomes
    // ('no-owner', 'opted-out', 'bounced', 'interrupted', ...) — never
    // free-text PII.
    detail: text("detail"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("communications_idempotency_key").on(t.idempotencyKey),
    index("communications_person_idx").on(t.personId),
    index("communications_animal_idx").on(t.animalId),
    index("communications_related_idx").on(t.relatedType, t.relatedId),
    // The delivery drain's hot read: pending work, oldest first.
    index("communications_queued_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
    // Reclaim of abandoned in-flight sends.
    index("communications_sending_idx")
      .on(t.lastAttemptAt)
      .where(sql`${t.status} = 'sending'`),
    // The staff exception read: terminal non-success outcomes.
    index("communications_exceptions_idx")
      .on(t.createdAt)
      .where(sql`${t.status} IN ('failed','skipped')`),
    check(
      "communications_channel_check",
      sql`${t.channel} IN ('email','sms','whatsapp','phone')`,
    ),
    check(
      "communications_status_check",
      sql`${t.status} IN ('queued','sending','sent','delivered','failed','skipped')`,
    ),
    // sent_at is stamped exactly when the provider accepts the message
    // and stays set forever after — a sent-then-bounced row keeps it.
    // Only one direction holds: sent/delivered REQUIRE sent_at, but a
    // 'failed' row may retain it as honest history.
    check(
      "communications_sent_consistency_check",
      sql`${t.sentAt} IS NOT NULL OR ${t.status} NOT IN ('sent','delivered')`,
    ),
    // delivered_at survives a late bounce — the delivery genuinely
    // happened, then failed; 'failed' is the honest terminal state.
    check(
      "communications_delivered_consistency_check",
      sql`${t.deliveredAt} IS NULL OR ${t.status} IN ('delivered','failed')`,
    ),
    check("communications_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

// Per-person communication preferences (#172). A row records whether
// the person opts out of a given reminder kind on a channel; absence
// of a row means the default (opted in). Opt-outs only suppress kinds
// the reminder policy marks optional — operational registry notices
// (registration due, balance owed, annual confirmation) are never
// silenced by a preference row; see src/lib/reminders/policy.ts.
export const communicationPreferences = pgTable(
  "communication_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    kind: text("kind").notNull(),
    optedOut: boolean("opted_out").notNull().default(false),
    // Who recorded the preference — a staff label or the person
    // themselves once #166's owner portal exists.
    actorLabel: text("actor_label"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("communication_preferences_person_kind_key").on(
      t.personId,
      t.channel,
      t.kind,
    ),
    check(
      "communication_preferences_channel_check",
      sql`${t.channel} IN ('email','sms','whatsapp','phone')`,
    ),
    check(
      "communication_preferences_kind_check",
      sql`${t.kind} IN ('vaccination-reminder')`,
    ),
  ],
);

// --- Audit ------------------------------------------------------------------
// Append-only mutation history (#177 supports the dashboard UI). Written
// by domain services; nothing in the app updates or deletes these rows.

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorIdentityId: uuid("actor_identity_id").references(
      () => authIdentities.id,
      { onDelete: "set null" },
    ),
    // Human-readable fallback for system actors / pre-link identities.
    actorLabel: text("actor_label"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(), // uuid or legacy firestore id
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);
