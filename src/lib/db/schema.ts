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
// Permanent durable identity. lifecycleStatus mirrors the canonical
// lifecycle in src/lib/animal-lifecycle.ts and firestore.rules — extend
// the CHECK list via migration as registry statuses are added. Annual
// registration and payment state are deliberately NOT columns here.

export const animals = pgTable(
  "animals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Firestore document ID — keeps /animal-adoptions/[id] URLs stable
    // across migration. Null for Postgres-native records.
    legacyId: text("legacy_id"),
    name: text("name").notNull(),
    species: text("species").notNull(),
    sex: text("sex").notNull(),
    approxAge: text("approx_age"),
    description: text("description"),
    lifecycleStatus: text("lifecycle_status").notNull(),
    photoUrls: text("photo_urls").array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("animals_legacy_id_key").on(t.legacyId),
    index("animals_lifecycle_status_idx").on(t.lifecycleStatus),
    check(
      "animals_species_check",
      sql`${t.species} IN ('dog','cat','other')`,
    ),
    check("animals_sex_check", sql`${t.sex} IN ('male','female','unknown')`),
    check(
      "animals_lifecycle_status_check",
      sql`${t.lifecycleStatus} IN ('available','pending','adopted')`,
    ),
  ],
);

// Historical ownership — animal ↔ person OR household. Never rewritten:
// an ownership change closes validTo on the old row and opens a new one.
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
    createdAt: createdAt(),
  },
  (t) => [
    index("ownerships_animal_idx").on(t.animalId),
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

// Lightweight veterinary-event foundation — exams, notes, treatments.
// Not a full EMR; details jsonb carries event-specific payload until the
// dedicated issues (#174) flesh out per-type shape. Structured
// vaccination records live in `vaccinations` (#173) — a 'vaccination'
// vet_event remains legal only for unverifiable historical mentions
// (e.g. "owner reports rabies ~2021") that lack structured fields.
export const vetEvents = pgTable(
  "vet_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
    eventType: text("event_type").notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    summary: text("summary").notNull(),
    // Vaccination validity window — drives future reminders (#172/#173).
    validUntil: date("valid_until", { mode: "string" }),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [
    index("vet_events_animal_idx").on(t.animalId),
    check(
      "vet_events_type_check",
      sql`${t.eventType} IN ('vaccination','exam','treatment','surgery','note','other')`,
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
// No vet_visits/encounters table yet: vaccinations legitimately have no
// visit (historical backfill, external clinic records). #174 can add a
// nullable visit_id without migrating data.
export const vaccinations = pgTable(
  "vaccinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    animalId: uuid("animal_id")
      .notNull()
      .references(() => animals.id), // restrictive — medical history
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

// Follow-up / recheck queue (#175).
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
    kind: text("kind").notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    status: text("status").notNull().default("open"),
    notes: text("notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("follow_ups_due_idx").on(t.dueOn),
    check(
      "follow_ups_status_check",
      sql`${t.status} IN ('open','done','cancelled')`,
    ),
  ],
);

// Outbound communication / reminder send log (#172). idempotencyKey makes
// reminder sends safe to retry without double-sending.
export const communications = pgTable(
  "communications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    channel: text("channel").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key"),
    // Loose entity reference (e.g. "registration", uuid string) — any
    // domain entity may drive a message without a rigid FK web.
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("communications_idempotency_key").on(t.idempotencyKey),
    index("communications_person_idx").on(t.personId),
    check(
      "communications_channel_check",
      sql`${t.channel} IN ('email','sms','whatsapp','phone')`,
    ),
    check(
      "communications_status_check",
      sql`${t.status} IN ('queued','sent','failed','skipped')`,
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
