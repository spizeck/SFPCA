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
// structured vocabulary — 'spay'/'neuter' are the authoritative
// sterilization record (reporting reads these; there is intentionally
// NO animals.sterilized column duplicating this truth). performed_on is
// nullable because historical procedures often have no known date
// ("was already spayed at intake"); the approximation lives in notes.
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
