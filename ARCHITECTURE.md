# Persistence Architecture — Firestore → Neon/Postgres (#165)

This document is the authoritative map of **which datastore owns which
data** and the staged path from the current Firestore model to the
relational animal registry. If you are adding a feature that touches
animals, owners, registrations, payments, chips, vaccinations,
reminders, or audit data, read this before writing code — putting new
registry data in Firestore is now a mistake, not a shortcut.

```
                Public visitors                    Staff (admin UI)
                      │                                   │
                      ▼                                   ▼
        ┌─────────────────────────┐         ┌──────────────────────────┐
        │  Next.js public pages   │         │  Next.js /admin pages     │
        │  (static + SSR)         │         │  (Firebase session cookie)│
        └───────────┬─────────────┘         └─────────────┬────────────┘
                    │                                     │
     ┌──────────────┼─────────────────────────────────────┼──────────────┐
     │              ▼                                     ▼              │
     │   ┌────────────────────┐              ┌────────────────────────┐  │
     │   │ Firestore          │              │ Postgres (Neon)        │  │
     │   │ CMS content        │              │ registry domain        │  │
     │   │ (retained)         │              │ (authoritative, #183)  │  │
     │   └────────────────────┘              └────────────────────────┘  │
     │   ┌────────────────────┐              ┌────────────────────────┐  │
     │   │ Firebase Storage   │              │ Firebase Auth          │  │
     │   │ receipts/ team-…   │              │ authentication only    │  │
     │   └────────────────────┘              └────────────────────────┘  │
     └──────────────────────────────────────────────────────────────────┘
```

## 1. Current persistence inventory (post-#183)

| Collection/table | Kind | Privacy | Readers | Writers |
|---|---|---|---|---|
| `homepage/main` | CMS (Firestore) | public read | public pages (server) | admin client SDK + `admin/homepage/actions.ts` (Admin SDK) |
| `siteSettings/global` | CMS (Firestore) | public read | public pages, footer, contact | admin client SDK |
| `vetServices/main` | CMS (Firestore) | public read | `/vet-services` | admin client SDK |
| `animalAdoptions/main` | CMS (Firestore) | public read | `/animal-adoptions` | admin client SDK |
| `animalRegistration/main` | CMS (Firestore) | public read | `/animal-registration` copy | admin client SDK |
| `faq/*` | CMS (Firestore) | public read | `/faq`, homepage FAQ section | admin client SDK |
| `animals` (Postgres) | **operational** | public iff `adoption_status='available'` AND `lifecycle_status='active'` | `src/lib/registry/public-animals.ts` (public DTO); `registry/animals.ts` (admin) | `admin/animals/actions.ts` server actions |
| `registration_submissions` (Postgres) | **operational, PII** | admin-only; never public | `registry/registrations.ts` | `animal-registration/actions.ts` (public intake); `admin/registrations/actions.ts` (review) |
| `admin_users` (Postgres) | **authz config** | server-only | `registry/admin-users.ts` → `isAdmin()` | `provisionAdminUser` (session route, insert-only) / SQL |
| `vaccinations` (Postgres) | **operational, medical** | admin-only; never public | `registry/vaccinations.ts` | `admin/animals/[id]/actions.ts` server actions |
| `vet_encounters` / `vet_procedures` / `vet_medications` / `medical_alerts` / `weight_records` / `vet_documents` (Postgres) | **operational, medical** | admin-only; never public | `registry/medical.ts` | `admin/animals/[id]/actions.ts` server actions |
| `audit_events` (Postgres) | **audit** | server-only | (append-only) | domain services, transactional with mutations |
| Firestore `animals`/`animalRegistrations`/`admins` | **retired** | deny-all in rules for every principal | — none — | — none — |

Storage prefixes: `receipts/<submission uuid>` (private PII — public
constrained create only; no client read/update/delete for anyone; staff
view via server-minted signed URLs; orphan cleanup via Admin SDK sweep),
`team-photos/` (public read, admin-claim image upload <5 MB). `images/`
and `animals/` are deny-all. `vet-docs/` is reserved for clinical
documents (#174 establishes `vet_documents` rows referencing it) —
private, staff-only; the uploader and its Storage rules land with the
document-upload feature, until then the prefix stays deny-all.

Firebase Auth: email/password, session cookie (`/api/auth/session`).
Authorization = Postgres `admin_users` lookup in `isAdmin()`; the session
route sets a `admin` custom claim that Firestore/Storage rules consult
for client-SDK writes (CMS saves, team-photo uploads). `ADMIN_EMAILS`
remains a bootstrap/emergency allowlist only — it provisions the first
`admin_users` row and never rewrites a staff-managed role.

Functions: `onFirestoreChange` → Vercel rebuild for **CMS collections
only** (`REBUILD_COLLECTIONS`); `triggerRebuild` (HTTP, bearer token).
Registry writes invalidate via `revalidatePath` in the server actions —
the public listing/detail pages are `force-dynamic`, the homepage
preview revalidates on mutation; no rebuild hook is needed for Postgres
writes. Orphan-receipt cleanup is `/api/cron/sweep-receipts` (Vercel
cron) keyed on Postgres `registration_submissions` existence.

## 2. Persistence boundary

| Data | Destination | Why |
|---|---|---|
| `animals` | **Postgres** (done, #183) | Permanent registry records; ownership/registration/chip/vet relations; audit trail on every mutation |
| `animalRegistrations` → `registration_submissions` | **Postgres** (done, #183) | Owner PII + payment-adjacent data; intake snapshot now, `persons`/`registrations` link-up is #178 |
| `admins` → `admin_users` | **Postgres** (done, #183) | Staff authorization is registry domain |
| `homepage`, `siteSettings`, `vetServices`, `animalAdoptions`, `animalRegistration` (page copy), `faq` | **Firestore (stays)** | Low-churn CMS content behind the rebuild-trigger pipeline; relational modeling buys nothing and would break `onFirestoreChange` → rebuild |
| `receipts/`, `team-photos/` | **Firebase Storage (stays)** | Binary objects never live in Postgres; Postgres stores path references only |
| Ownership, registrations, payments, chips, medical records, follow-ups, communications, audit | **Postgres** | Relational + historical by definition |

Naming convention that makes authority obvious:

- `src/lib/db/*` — Postgres schema/client/migrations (Drizzle)
- `src/lib/registry/*` — Postgres-backed domain services (server-only);
  the ONLY seam through which registry data is read or written
- `src/lib/firebase*.ts`, page-content loaders — Firebase Auth,
  Storage, and the Firestore/CMS side
- `src/app/admin/**` registry surfaces call server actions that
  self-authorize via `requireAdmin`; **registry writes never go to
  Firestore** — the operational collections are deny-all

## 3. Auth boundary

Firebase Auth **remains** the authentication provider — this issue does
not replace working auth. The distinction that matters:

- **Authentication identity** — Firebase Auth user (email/password),
  verified via session cookie + Admin SDK. Proves *who signed in*.
- **Domain records** — `persons` (registry people: owners, contacts,
  staff), `admin_users` (staff authorization, keyed by normalized email
  like today's `admins/` docs), `auth_identities` (provider + Firebase
  UID → person link).

```
Firebase Auth user ──uid──▶ auth_identities ──person_id──▶ persons
      │email                     ▲
      └──────────────────────────┤  admin_users.email (normalized,
                                 │  unique) + role admin|editor
                                 └── linked on first sign-in
```

Post-#183 authorization: `admin_users` is the authoritative staff record
(queried by `isAdmin()` on every admin surface); `ADMIN_EMAILS` remains
the bootstrap/emergency path — an env-listed email can sign in and gets
an `admin_users` row provisioned (insert-only, never rewrites a role).
The session route also stamps a Firebase custom claim
(`admin`, `adminRole`) so Firestore/Storage rules keep authorizing
client-SDK writes (CMS edits, team-photo uploads) now that the
`admins/` collection is retired; the claim is cleared on refused
logins. Owner accounts (#166) are `auth_identities` + `persons` rows —
the same chain, no second auth authority; see §5 "Owner registry".

## 4. Stack selection

**Neon Postgres** (serverless Postgres, Vercel-native integration,
branching, instant restore) + **Drizzle ORM** + **`postgres`
(postgres.js)** driver. Chosen over Prisma deliberately:

| Criterion | Drizzle + postgres.js | Prisma |
|---|---|---|
| Runtime footprint | SQL strings; no engine binary | Query engine / driver adapters |
| Vercel serverless | Tiny cold-start cost; pooled Neon endpoint works directly | Needs adapter or engine packaging |
| Migrations | `drizzle-kit generate` → checked-in deterministic SQL | `prisma migrate` — equally good |
| Type safety | Schema is TS; types inferred, no codegen step | Generated client |
| Raw SQL escape | `sql` template is first-class | `queryRaw` works, less idiomatic |
| Testing | PGlite driver is native (`drizzle-orm/pglite`) | Needs real Postgres or heavy setup |

Drizzle keeps SQL visible — for a team migrating *from* a document DB,
the schema reads as the SQL it produces, and migration files are reviewable
plain SQL.

## 5. Relational model (implemented in `src/lib/db/schema.ts`)

| Table | Purpose | Key invariants |
|---|---|---|
| `persons` | Registry people (owners, contacts, staff) | no auth coupling; email indexed, **not** unique (households share) |
| `auth_identities` | Firebase UID → Person map | `unique(provider, provider_uid)` |
| `admin_users` | Staff allowlist | `unique(lower(email))`, role `admin\|editor` CHECK |
| `households` + `household_members` | Grouped people/animals | composite PK, role CHECK |
| `animals` | Permanent animal identity (#167) | `unique(legacy_id)`; sequential `registry_ref` (`SFPCA-######`); species/sex/lifecycle/adoption/sterilization CHECKs; `birth_date` + `birth_date_estimated` (estimate requires a date); **no** registration/payment columns — the record exists independently of owner, registration, payment, vet visit, vaccination, or portal account |
| `animal_lifecycle_events` | Append-only lifecycle history (#167) | `from_status`/`to_status` CHECKs (`null` from = registry entry); `source` CHECK `staff\|owner-request\|import`; `effective_on` is the real-world date (may precede `created_at`); restrictive animal FK |
| `ownerships` | Historical animal↔person/household | exactly one of person/household (`num_nonnulls=1`); `valid_to > valid_from` |
| `ownership_confirmations` | Append-only annual-confirmation events (#166) | one row per deliberate "still mine, still on Saba" attestation; restrictive FKs — evidence survives owner churn; `person_id` is the attesting member, `confirmed_by_identity_id` the account used (null for staff-recorded) |
| `owner_requests` | Owner-originated requests + staff resolution (#166) | status CHECK `pending\|approved\|rejected\|cancelled`; `resolved_at`/`resolved_by` set exactly when leaving `pending`; kind CHECK `account-claim\|no-longer-mine\|transfer\|lifecycle-*`; `payload` holds free-text hints (never link keys) |
| `registration_submissions` | Intake events (today's `animalRegistrations`) | `unique(legacy_id)`; owner contact snapshot; receipt **path** only |
| `registrations` | Authoritative per-animal-per-year record (#169) | `unique(animal_id, year)` (cancelled rows keep the slot); status CHECK `active\|cancelled` — payment is derived, never a status; owner snapshot (`ownership_id`/`person_id`/`household_id` + `owner_label`); `submitted_at`/`registered_at` distinct; `amount_due_cents` non-negative integer + currency; `resolution` CHECK `waived\|complimentary`; cancellation reason/note consistency CHECK; restrictive animal + submission FKs |
| `payments` | Provider-neutral ledger (#170) | integer cents + currency; `kind` CHECK `payment\|refund\|adjustment`; `status` CHECK `pending\|confirmed\|failed\|void`; `method` CHECK `cash\|bank-transfer\|other\|online`; `source` CHECK `staff\|provider`; amount CHECK (payment/refund > 0, adjustment ≠ 0); provider-consistency CHECK (`method='online'` ⟺ provider set; provider_ref requires provider); partial `unique(provider, provider_ref)` — one authoritative external transaction applied at most once; partial `unique(idempotency_key)` — retries resolve to the existing row; `related_payment_id` links refunds/adjustments to their payment; no cascade deletes |
| `payment_events` | Append-only reconciliation history (#170) | one row per ledger event (`recorded`/`confirmed`/`failed`/`voided`/`refunded`/`adjusted`) with actor label, source, and bounded `detail` JSON — who/what changed each transaction and when; restrictive payment FK |
| `microchip_records` | Chip assignments w/ history (#168) | `chip_number` stored normalized; `chip_display` keeps as-entered formatting; optional implantation metadata (manufacturer/implanted_on/implanted_by/notes); partial `unique(chip_number)` AND `unique(animal_id)` `WHERE assigned_to IS NULL` — one active assignment per chip AND one current chip per animal; `closed_reason` CHECK `replaced\|removed\|corrected` + closure-consistency CHECK; `replaced_by_id` links a replaced row to its successor; restrictive animal FK |
| `microchip_conflicts` | Rejected duplicate chip claims (#168) | evidence rows, one open per (chip, claimant) via partial unique; `source` CHECK `staff\|import`; resolution is human — never auto-moves a chip |
| `lost_found_cases` | Missing/found case workflow (#176) — evolved from #168's `found_reports`, whose rows migrated here as `found` cases | `case_type` CHECK `missing\|found`; `status` CHECK `open\|resolved\|cancelled`; `outcome` CHECK `reunited\|owner-located\|in-care\|deceased\|other` (resolved rows only); CHECKs enforce missing⟹animal linked, resolved⟹outcome+timestamp, publish⟹missing+linked; partial uniques — one open missing AND one open found per animal, one open unmatched case per chip; `linked_at`/`linked_by` preserve "began unmatched"; `published_at` is the public-listing opt-in; restrictive animal/microchip FKs |
| `lost_found_updates` | Append-only case chronology (#176) — sightings, chip scans, staff beats; linkage/publish/resolve also write rows | `kind` CHECK `sighting\|scan\|update`; `source` CHECK `staff\|owner-portal\|public`; optional reporter fields stay private; restrictive case FK |
| `vet_encounters` | One dated clinical record per row (#174) — `kind` CHECK `visit`/`history`/`note` absorbs structured visits AND the old `vet_events` roles (reported history, standalone notes) | concise optional text fields (reason/complaint/findings/assessment/plan/notes); `visit` requires `reason`; no SOAP machinery |
| `vet_procedures` | Significant interventions incl. spay/neuter (#174) | kind CHECK; `performed_on` nullable (unknown historical dates); optional `encounter_id` |
| `vet_medications` | Medication/course history — treatment record, not prescribing | `end_on ≥ start_on` or null (ongoing); "active" derived, never stored |
| `medical_alerts` | Allergies/contraindications/conditions that must never hide in notes | `resolved_on` set exactly when `status='resolved'` |
| `weight_records` | Longitudinal weight | integer `weight_grams` — no ambiguous unit strings |
| `vet_documents` | Clinical document references (lab reports, certificates) | `storage_path ~ '^vet-docs/'` CHECK; uploader + Storage rules deferred — relational shape only |
| `vaccinations` | Structured vaccination history (#173) | restrictive FK to `animals`; `due_on`/`valid_until` ≥ `administered_on`; `series_key` generated from `vaccine_name` — only the latest dose per (animal, series) drives the due/reminder projection; due-state derived, never stored; optional `encounter_id` links a dose to the visit it was given at |
| `follow_ups` | Veterinary follow-up/recheck queue (#175) | status CHECK `open\|completed\|cancelled`; `resolved_at` set exactly when status leaves `open`; time-relative state (upcoming/due/overdue) derived by `followUpState()` — never stored; `reason` is the queue headline; `encounter_id` links a recheck to the visit that recommended it; `person_id` snapshots the owner at creation (history), the queue resolves the CURRENT owner separately; registration-linked rows are #177 operational work, not clinical |
| `clinic_expectations` | Expected clinic animals (#194) | status CHECK `expected\|seen\|no_show\|cancelled`; `resolved_at` consistency CHECK mirrors follow_ups; urgency derived by `clinicExpectationState()` — never stored; restrictive animal FK — expectations are history; `encounter_id` (set null) records the real visit that fulfilled a `seen` expectation — never manufactured; `person_id` snapshots the owner at creation; `session_label` is a free-text hint, not a slot |
| `communications` | Reminder ledger + send log | `unique(idempotency_key)` — safe retries; `<prefix>:<relatedId>:<cycleKey>:<touch>` keys; state machine `queued→sending→sent→delivered` with `failed`/`skipped` terminal; `sent_at`/`delivered_at` consistency CHECKs; recipient/subject/body snapshots preserve what was sent; `detail` is a bounded reason vocabulary, never free text |
| `communication_preferences` | Per-person opt-outs (#172) | `unique(person_id, channel, kind)`; opt-outs suppress only kinds the reminder policy marks optional — operational notices are never silenced by a preference row |
| `audit_events` | Append-only mutation history | entity type/id + before/after jsonb |

**Where invariants live:** DB constraints — identity uniqueness, FK
integrity, closed status vocabularies, ownership ranges, money shape.
Domain services — lifecycle transitions, dedupe, reminder scheduling.
UI validation — form shape only, never trusted.

**Permanent animal registry (#167):** `animals.id` (uuid) is the durable
identity — it never changes when ownership, name, microchip, or
lifecycle changes; `registry_ref` (`SFPCA-######`, sequence-generated)
is the human-readable reference for staff use, not a key. Two
deliberately separate vocabularies live on the row: `lifecycle_status`
(`active`/`deceased`/`moved-off-saba`/`unknown`) is the registry
reality, changed ONLY through `transitionAnimalLifecycle`, which lands
the current-state update, the `animal_lifecycle_events` history row,
ownership/follow-up side effects, and the audit row in one transaction
— every state can reach every other (corrections are history, not
rewrites), and ownership-ending states close ALL open intervals because
a deceased/off-island animal has no on-island owner of record.
`adoption_status` (`not-listed`/`available`/`pending`/`adopted`) is the
public-catalog switch, freely editable. Birth data avoids false
precision: `birth_date` is nullable and `birth_date_estimated` marks
approximations (rendered with `~`); the old free-text `approx_age`
column is gone — displays derive age at read time. Sterilization is an
animal-level fact (`sterilization_status`/`sterilized_on`/
`sterilized_by`) staff can assert for historical animals, while
`vet_procedures` spay/neuter rows remain the clinical evidence — writing
one marks the animal sterilized and fills still-empty fields in the same
transaction, but never overwrites an asserted fact. Photos stay as
validated URL strings (`photo_urls`); there is no `animals/` Storage
prefix. `/admin/animals` is the staff search surface (name, ref, uuid,
legacy id, identifying notes, owner/household, microchip + lifecycle /
listing filters) and `/admin/animals/[id]` is the canonical profile:
identity, lifecycle + history, sterilization + evidence, ownership,
registrations, payments, microchips, documents, audit. Registration
independence is a hard invariant — nothing infers existence or
lifecycle from current registration. Boundaries: #168 owns the
microchip workflow (below), #169 annual registration, #176 lost/found,
#178 duplicate merge.

**Microchip identity & the found-animal workflow (#168):** the
registry's answer to "a volunteer is standing next to a stray with a
scanner". Scanner assumption: **keyboard-wedge input followed by
Enter** — USB/Bluetooth scanners behave like keyboards, so no drivers
or hardware integration exist; `/admin/chip-lookup` is a focused,
autofocused, Enter-submit field that stays focused between scans.

- **Normalization.** `src/lib/microchips.ts` exports THE canonical
  `normalizeChipNumber`: uppercase, then strip everything outside
  A–Z0–9 (whitespace, hyphens, dots, asterisks, slashes are scanner/
  paperwork formatting; real chip formats — ISO 11784/11785, AVID,
  Trovan, Datamars — are alphanumeric only, so nothing meaningful is
  dropped). Lookup, creation, correction, registry search, imports,
  and duplicate detection all call it — two representations of one
  chip can never diverge. `chip_display` preserves the as-entered
  string for display whenever normalization removed formatting.
- **Uniqueness & conflicts.** Strict database protection: a second
  ACTIVE `microchip_records` row for a normalized number cannot exist
  (partial unique index), and one animal holds at most one current
  chip. A rejected duplicate claim is never silently overwritten or
  moved — the service returns `chip-conflict` and flags a
  `microchip_conflicts` row (open, deduped per chip+claimant) as
  human-resolution evidence. Resolution is manual: staff fix the
  underlying records, then mark the conflict resolved. #178 owns the
  generic duplicate/merge engine — this stays scoped to chip identity.
- **Current vs historical.** `assigned_to IS NULL` = current. A chip
  leaving use is CLOSED, never deleted: `closed_reason` records why —
  `replaced` (with `replaced_by_id` linking the successor, written in
  the same transaction so currency never gaps), `removed` (no
  successor), `corrected` (the record itself was wrong — never this
  animal's chip). A same-record data fix goes through the correction
  path — an audited in-place edit guarded by a `created_at` token —
  and never fabricates a replacement event.
- **Lookup.** `lookupChip` (`src/lib/registry/microchips.ts`) is an
  exact equality read on the indexed normalized column — no registry
  scan. Active matches rank first; a replaced/removed chip still
  identifies the animal and the result says so, surfacing the current
  chip alongside. **Lifecycle never suppresses a match** — a deceased
  or off-island animal still resolves, flagged for staff review
  because that discrepancy usually means stale registry state.
  `/admin/animals` search uses the same canonical normalization with
  left-anchored prefix matching (index-compatible — staff type chips
  left to right).
- **Owner contact.** The match result resolves WHO is current through
  the canonical `listCurrentOwnerships` projection — never a second
  definition — then renders contact detail: person owners directly,
  household ownerships through members (primary first). Multiple
  current ownerships render as ambiguous rather than guessed; an
  owner with no contact details and "no current owner" are explicit
  states, not silence. This data is staff-only: it arrives via a
  `requireAdmin`-gated server action, never in public DTOs, public
  pages, or page source.
- **Found events.** #168's `found_reports` scan log evolved into
  #176's `lost_found_cases` (migration rewrote the rows as `found`
  cases and dropped the old table — one representation of a
  found-animal event, not two). The scan workflow now routes through
  `openFoundCase` with deterministic dedupe: a scan of an animal with
  an open MISSING case lands as a 'scan' chronology row on THAT case
  (no duplicate found case), a rescan of an already-open case folds
  in, otherwise a new `found` case opens — or resolves immediately
  when an outcome is supplied. An unidentified scan flags an
  unmatched case keyed by chip number (one open per chip).
- **Profile & audit.** The animal profile's MicrochipPanel shows the
  current chip, full closed history, open conflicts, and found
  reports, with staff mutations (add / replace / end use / correct /
  resolve conflict). Every mutation lands an `audit_events` row in
  the same transaction; payloads carry chip data, not owner PII.
- **Owner portal.** Owners see their own animals' current chip number
  read-only — useful for vet visits and insurance; mutation stays
  staff-controlled and no other animal's chip is ever exposed. A
  future public "I found an animal" flow would need a separate
  public-safe lookup result — owner contact must never flow through
  it. (The lost-pets sighting form below is exactly that: it writes a
  case update to SFPCA and reveals nothing.)

**Lost/found cases (#176):** `lost_found_cases` is the durable work item
for "a registered animal is missing" or "an animal was found". It is
deliberately NOT part of the animal's permanent lifecycle — an animal
stays `lifecycle_status='active'` while a missing case is open and stays
the same registry record when the case resolves; `missing` is not and
never becomes a lifecycle status.

- **Vocabulary.** `case_type` `missing|found`; `status`
  `open|resolved|cancelled`; `outcome` on resolved rows only:
  `reunited`, `owner-located` (owner found, animal not yet physically
  home), `in-care`, `deceased`, `other`. Vocabulary lives in
  `src/lib/lost-found.ts`; schema CHECKs keep `resolved ⟺ outcome +
  resolved_at` consistent.
- **Unmatched found animals.** A `found` case may carry `animal_id`
  NULL — an unknown chip or an unregistered stray is a real case with
  description/found details, never a fabricated `animals` row. Staff
  link it to the registry explicitly (chip scan or manual search);
  `linked_at`/`linked_by` permanently record that the case began
  unmatched. `missing` cases always require the link (CHECK) — there
  is no such thing as a missing unregistered animal.
- **Invariants.** Partial unique indexes enforce at most one open
  `missing` and one open `found` case per animal (both may coexist —
  the pair IS the "missing animal was found" signal) and one open
  unmatched case per chip number. Resolving either sibling resolves
  the other with the same outcome in the same transaction;
  cancelling never propagates (only the wrong case dies). `deceased`
  is the one outcome that touches the registry: it drives the
  canonical `transitionAnimalLifecycle` first — if the transition
  can't land, the case stays open.
- **Chronology.** `lost_found_updates` is the append-only timeline —
  sightings, chip scans, staff beats; linkage, publication, and
  sibling-resolutions write rows too, so the case tells its whole
  story. Reporter name/contact on updates is private and never in
  public DTOs.
- **Publication.** `published_at`/`published_by`/`public_note` are the
  explicit staff opt-in to the public `/lost-pets` page — open alone
  never publishes. `listPublishedLostAnimals` is the ONLY public
  read: it filters `published_at IS NOT NULL AND status='open'` (a
  resolved case de-lists automatically) and returns an allowlist DTO
  — name/photo/species/sex/approx age/date/location/approved note.
  No owner or reporter contact, no staff notes, no chip data. The
  public "I've seen this animal" form writes ONLY a `public`-source
  sighting row onto a case the page currently lists — it confirms
  nothing about private cases and opens no channel to the owner.
- **Owner reporting.** `reportMissingByOwner` is the portal's "my
  animal is missing" path — deliberately NOT an `owner_requests`
  item (a missing report is low-risk, unambiguous information; the
  case itself is the staff-visible work item). Authorization is the
  same canonical `getOwnedOwnership` check every portal mutation
  uses — currently-valid ownership held by this person, direct or
  household — so former owners are denied. The case records
  `reported_via='owner-portal'` and the actor identity.
- **Notifications.** Resolution and found-matches queue a single
  `lost-found-notice` row in the communications ledger (#172) for
  the animal's strictly-resolved owner — idempotency-keyed, and
  inserted post-commit so a ledger failure can never roll back the
  case. Non-sendable resolutions record a `skipped` row so the
  exception pipeline still sees them.
- **Surfaces.** `/admin/lost-found` is the exception-first staff
  workspace (missing / unmatched found / matched awaiting resolution /
  recently closed) with per-case detail; the animal profile carries a
  Lost & Found panel; chip-lookup is the scanner's entry point. The
  dashboard card reads `getOpenCaseCounts` — the canonical queue
  service #177's exception dashboard should compose, not re-query.

**Annual registrations (#169):** `registrations` is the authoritative
per-animal-per-year record — the durable history of "this animal was
registered for this period". It is deliberately distinct from
`registration_submissions`, which remains the intake record: a public
form submission is the applicant's claim, never proof of identity,
ownership, payment, or registration. Staff review submissions and then
explicitly create the authoritative row (the intake card's link action
or the queue's Register button); approval of a submission does not
silently register an animal.

- **Period.** Calendar-year: `year` is the period, centralized in
  `src/lib/registrations.ts` (`currentRegistrationYear(asOf)` accepts
  an explicit date so tests never roll over with the calendar;
  `registrationPeriodLabel` is the display form). No year is
  hard-coded outside that module.
- **Record.** `unique(animal_id, year)` — one authoritative row per
  animal per period, cancelled rows included (a cancelled row keeps
  its slot; staff correct rather than re-add). `submitted_at` and
  `registered_at` are distinct timestamps. The owner is frozen as a
  registration-time snapshot — `ownership_id`/`person_id`/
  `household_id` FKs plus `owner_label`, so history survives later
  ownership transfers and renames.
- **Status vs payment.** `status` is `active`/`cancelled` only —
  payment is NEVER a status. `paymentState` is derived at read time
  by `derivePaymentState(amount_due, confirmed_paid, resolution)` over
  the `payments` ledger, so stored state can never disagree with
  recorded money. `amount_due_cents` is an assessment snapshot taken
  at creation (sterilized → fixed fee, else the intact fee —
  `REGISTRATION_FEE_*` in `animal-registration.ts` — or an explicit
  staff override); later fee changes never rewrite history.
- **Non-payment resolution.** `waived`/`complimentary` are explicit
  audited `resolution` values — never a fake $0 payment. Corrections
  are `correct-amount` audits carrying before/after; a wrong row is
  cancelled with a mandatory note (`cancellation_reason` ∈
  `correction`/`withdrawn`), not edited away.
- **Eligibility.** `listUnregisteredAnimals` is THE canonical
  current-period source shared by the staff queue, the portal, and
  the #172 evaluator: lifecycle `active`/`unknown` animals with no
  `active` registration for the period. `deceased`/`moved-off-saba`
  never appear as gaps; lifecycle is never inferred from registration.
- **Queues.** `getRegistrationQueues` powers `/admin/registrations`:
  unregistered-for-period, pending intake submissions, outstanding
  balance, and completed — all set-based reads, every row linking to
  the canonical animal profile (RegistrationPanel: register, record
  payment, waive/complimentary, correct amount, notes, cancel).
- **Owner portal.** `listPortalAnimals` projects current-period state
  (`paymentState`, amount due, paid/outstanding cents) plus the list
  of registered years — owner-scoped only, no staff notes, references,
  or provider internals.

**Registration payment ledger (#170):** `payments` is the authoritative
provider-neutral transaction table and `src/lib/registry/payments.ts`
is the ONLY write path — every money mutation is transactional, locks
the rows it acts on, and records both an append-only `payment_events`
reconciliation row and (for staff actions) an `audit_events` row.

- **Payment initiation is not payment truth.** Only `confirmed` rows
  move a balance. `pending` is declared intent (a claimed bank
  transfer, a provider checkout) and never settles; `failed`/`void`
  are terminal non-events. A browser return, checkout creation, or
  "payment started" event can never mark a registration paid — the
  only paths to `confirmed` are the staff `confirmPayment` action and
  the provider `reconcileProviderOutcome` seam.
- **Kinds and methods.** `payment` (money in), `refund` (money out,
  positive amount subtracting in the projection, linked to the
  original via `related_payment_id`), and `adjustment` (signed
  bookkeeping correction of confirmed money where no money moved —
  reason mandatory). Methods: `cash`/`bank-transfer`/`other` are the
  staff vocabulary; `online` is reserved for provider-mediated money
  and requires `provider` + provider identity by CHECK.
- **Append-oriented.** A confirmed row is never edited. Refunds and
  adjustments are new rows; pending transitions are one-way
  (pending → confirmed|failed|void) and land in `payment_events`.
  Void requires a reason; refund requires a reason and validates the
  per-payment refundable cap under a row lock.
- **Canonical balance formula** (`deriveRegistrationBalance` in
  `src/lib/payments.ts`, the client-safe vocabulary module):
  `settled = received − refunded + adjustments` over confirmed rows;
  `outstanding = max(assessed − settled, 0)` (zero for waived/
  complimentary); `overpaid = max(settled − assessed, 0)` surfaced
  explicitly; `pending` exposed separately and never subtracts.
  `paymentState` derives as before (`no-fee`/`unpaid`/`partial`/
  `paid`/`waived`/`complimentary`). Queues, portal, the reminder
  evaluator, and every DTO consume this one formula — nothing
  re-implements the arithmetic.
- **External identity & idempotency.** Scoped `(provider,
  provider_ref)` uniqueness means one authoritative external
  transaction applies at most once; `idempotency_key` dedupes
  caller-side retries (staff form tokens). Repeated authoritative
  events resolve to the existing row (`applied:'existing'`); a
  terminal row whose stored outcome disagrees is a `conflict`, never
  a silent overwrite.
- **Correction boundaries.** `correctRegistrationAmount` changes the
  ASSESSED obligation (audited before/after) — never the ledger.
  `recordAdjustment` corrects confirmed MONEY where nothing moved.
  `voidPayment` cancels an unsettled pending record. `refundPayment`
  returns real money. Waived/complimentary stay explicit
  registration resolutions — no fake $0 payments exist.
- **Manual workflow.** `recordManualPayment` records cash/bank/other
  as confirmed money (with optional reference + note + staff actor);
  a claimed-but-unconfirmed bank transfer may record `pending` and
  is confirmed later by `confirmPayment` — the honest two-step the
  ledger demands before money counts.
- **Provider seam (#171).** `initiateProviderPayment` persists a
  `pending`/`online`/`source='provider'` row keyed on
  `(provider, providerRef)`; `reconcileProviderOutcome` applies an
  authoritative confirmed/failed result idempotently under row
  locks. A future Sentoo webhook/checkout lands here without
  rewriting balance logic; browser return pages carry no authority
  and have no seam at all.
- **Reconciliation history.** `payment_events` preserves who/what
  performed each transition and when (recorded/confirmed/failed/
  voided/refunded/adjusted) with bounded `detail` — the domain record
  staff audit a balance from, alongside the `audit_events`
  privileged-mutation trail.
- **Receipts.** Unchanged by #170: `registration_submissions.
  payment_receipt_path` stays the applicant's intake evidence —
  private Firebase Storage object, path-only in Postgres, staff view
  via short-lived signed URLs, orphan sweep intact. Ledger rows carry
  a `reference` (bank confirmation, receipt-book number) instead of
  uploaded binaries; owner DTOs never expose storage paths.
- **Unpaid-balance reminder (#172 activation).**
  `registration-payment-reminder` is now active through the existing
  pipeline: eligibility is `listUnpaidRegistrations` — the canonical
  balance projection, so only confirmed money settles, pending
  transactions neither suppress nor satisfy, and settlement stops the
  reminder automatically. Policy: operational (not opt-out-able),
  30-day cooldown, 2 touches per period, 14-day grace after
  registration.

**Veterinary continuity model (#174):** the admin animal page is a
single chronological timeline (`listMedicalTimeline`) combining
encounters, vaccinations, procedures, medications, weights, and alerts
— a rotating vet scans one list instead of six tables. Encounters are
deliberately concise: optional free-text sections instead of a SOAP
schema. `vet_events` was **removed** — nothing wrote it, and keeping a
second free-form medical table would leave two competing models. Its
roles are absorbed: a standalone note is an encounter `kind='note'`,
reported/unverifiable history is `kind='history'`. Provider attribution
is **free text** on each record (rotating/visiting vets are not registry
persons; a login account must never gate historical attribution).
`vaccinations` and `microchip_records` remain authoritative — an
encounter links to them, never duplicates them. All medical FKs to
`animals` are restrictive so history survives registration/owner
churn; corrections are audited edits with optimistic concurrency, not
deletes. This is a continuity record, not an EMR: no scheduling,
billing, prescribing, or diagnosis coding.

**Veterinary work queue (#175):** `/admin/vet` is the staff action
list — "what needs attention" across all animals, read through
`src/lib/registry/vet-queue.ts` (`listVetQueue`/`vetQueueSummary`). It
composes four sources into one urgency-sorted list: open `follow_ups`
(rechecks — created inline by encounters or standalone from the animal
record), unresolved `clinic_expectations` (#194 — see below),
vaccinations due/overdue **delegated to `listDueVaccinations`**
(#173's canonical query — the queue never re-derives vaccine state, and
the reminder foundation can never disagree with the queue), and active
`medical_alerts` at `critical`/`important` severity (`info` alerts stay
on the record — context, not tasks). Boundary semantics: `due_on <
today` is overdue, `= today` is due, `> today` is upcoming. Completing
or cancelling a follow-up is a guarded transition (row lock +
`updated_at` token, audited under `complete`/`cancel`) that stamps
`resolved_at` — there is no delete path, resolved rows render as
collapsed history on the animal record. Reminder delivery is **#172's**
job — the queue exposes the canonical data set; scheduling,
preferences, retries, and send history live there. The broader
exception dashboard is **#177's** — it should compose
`vetQueueSummary()` rather than re-query these tables.

**Expected clinic animals (#194):** `clinic_expectations` answers "who
is coming to the next clinic session" — scheduling intent for periodic
vet coverage, deliberately NOT appointment software (no slots, times,
calendars, or confirmations). It is its own table rather than a
`follow_ups` kind because the concept differs: a follow-up is medical
work that needs doing; an expectation is attendance intent. Lifecycle:
`expected` (only live state) → `seen` | `no_show` | `cancelled`, all
terminal, all audited guarded transitions, `resolved_at` stamped — no
delete path. `clinicExpectationState()` derives urgency from
`expected_on` vs today: past-due-still-expected renders overdue
("failed to appear — resolve it"), today is due, future is upcoming.
Marking `seen` optionally links the `vet_encounters` row that fulfilled
it — validated against the same animal; if no visit was logged yet the
expectation is simply `seen` with a null link and no clinical facts are
manufactured. Encounters never auto-create or auto-resolve
expectations: a recheck and an expectation are different intents, and
auto-linking would fabricate attendance. Queue ordering is unchanged —
expectations participate in the dated-work ranking (overdue → due →
upcoming), ahead of alerts. #172 may later consume this list for
clinic reminders; the model stores no delivery state.

**Owner registry (#166):** the durable owner/household side of the
animal registry, built on the #183 schema. The governing rule: **a
login account is not the ownership record** — `persons`,
`auth_identities`, `households`/`household_members`, `animals`, and
`ownerships` stay separate concepts.

- **Identity linking.** Every verified login upserts an
  `auth_identities` row (`unique(provider, provider_uid)`, email is a
  refreshed snapshot). `provisionOwnerLink` then resolves the person:
  an already-linked identity stays linked; an unlinked identity with no
  matching unclaimed person gets a **new** person (exposing nothing
  that isn't the caller's own); an identity whose email matches an
  unclaimed person files an `account-claim` **request** — a typed
  registry email is never proof of identity, and staff approve the link
  at `/admin/requests`. Session creation is best-effort: a Postgres
  failure must not lock staff out of admin.
- **Households.** `household_members` grants portal *authorization*,
  never ownership: members of a household may view and attest for
  household-owned animals, but the `ownerships` row names the household
  and membership changes never rewrite animal history.
- **Ownership intervals.** `[valid_from, valid_to)`; `valid_to NULL` is
  current. Mutations close one interval and open another — history is
  never overwritten. Same-owner overlapping intervals are rejected;
  different-owner overlap is legitimate co-ownership.
  `src/lib/registry/ownership.ts` is the canonical service: current/
  history reads, create/close/transfer/correct mutations (audited),
  and `currentOwnerPersonIdAt` / `resolveAnimalOwner` — the single
  current-owner projection that vaccinations, the vet queue, medical
  snapshots, and communications all delegate to (deterministic:
  person rows preferred over household, earliest `valid_from`, id
  tiebreak; sending paths fail closed on ambiguity).
- **Owner portal.** `/portal` serves owner-scoped DTOs only
  (`PortalAnimal`, `OwnerRequestRecord`, `PersonRecord`) — no staff
  notes, medical data, communications, or other owners. Every action in
  `portal/actions.ts` re-resolves session → identity → person and
  re-verifies `getOwnedOwnership` — a client-supplied ownership id is
  never proof. Unlinked identities see only the pending-claim state.
- **Annual confirmation.** `ownership_confirmations` is the
  authoritative evidence: one row per deliberate attestation recording
  ownership, animal, person, date, method, and actor identity.
  Eligibility derives from `MAX(confirmed_on)` and `valid_from` —
  never `updated_at` — via the canonical
  `listOwnershipsRequiringConfirmation` (#172's eligibility source).
- **Requests.** `owner_requests` is the durable record of everything an
  owner asks the registry to change. The portal writes `pending` rows;
  `/admin/requests` resolves them, applying the real change (link
  identity, close/transfer ownership) transactionally with the status
  flip. `lifecycle-deceased`/`lifecycle-moved-off-saba` approval runs
  `transitionAnimalLifecycle` (#167's authoritative write path) before
  the status flip: the animal's lifecycle changes, every open ownership
  interval — the reporter's AND co-owners' — closes at the effective
  date, open follow-ups/clinic expectations cancel, and the
  `animal_lifecycle_events` row carries `source='owner-request'` +
  `source_ref=<request id>`. If the transition fails the request stays
  pending. `listOwnerRequests` is the canonical exception query #177's
  dashboard should compose.

**Owner communications & reminders (#172):** automated follow-up is one
pipeline with five separate stages — eligibility, intent, delivery,
outcome, retry — and the `communications` ledger is authoritative for
all of them (provider dashboards are diagnostic, never the truth).
`src/lib/reminders/policy.ts` is the single place that defines when a
reminder kind is eligible, its cooldown, and its touch cap — typed code
config, not a rule engine. `src/lib/registry/reminders.ts` hosts one
evaluator per kind (registered in `EVALUATORS`) and the
`runReminderCycle` orchestration: evaluate → insert `queued`/`skipped`
rows under deterministic idempotency keys → drain the queue through the
`EmailSender` seam. `src/lib/registry/communications.ts` owns the
ledger: claim is one conditional UPDATE (no lock across the provider
call), failure classification is `rejected`/`unavailable`/`uncertain`,
and only `unavailable` auto-retries — an uncertain send parks as
`failed`/`interrupted` for staff reconcile, because a duplicate
reminder is worse than a delayed one. Provider: **Resend**
(`src/lib/email.ts`) — the row uuid is sent as its `Idempotency-Key`,
and `/api/webhooks/resend` applies verified `delivered`/`bounced`/
`failed`/`complained` events back onto rows by provider message id
(forward transitions only, redelivery-safe). Delivery is scheduled by
`/api/cron/reminders` (Vercel cron); `?dry_run=1` runs the same
eligibility without writing or sending, and `/admin/communications`
exposes the exception-first staff surface plus a preview button.
**Active reminder kinds:** `vaccination-reminder` (#173's
`listDueVaccinations`) and `annual-confirmation-reminder` (#166's
`listOwnershipsRequiringConfirmation` — activated now that deliberate
confirmation state exists; household-owned animals resolve to a
contactable member, and the kind is non-optional so opt-out
preferences cannot silence an obligation notice — the
`communication_preferences` CHECK refuses the kind outright). #169
activated `registration-due-reminder`: its eligibility is the canonical
`listUnregisteredAnimals` restricted to lifecycle 'active' (the staff
queue still lists 'unknown', but an unconfirmed animal is never
emailed), cycle-keyed on the period year, asking owners to register —
it never mentions money. #170 activated
`registration-payment-reminder`: its eligibility is the canonical
`listUnpaidRegistrations` — active registrations whose ledger balance
is positive — cycle-keyed on the period year, operational (not
suppressible by preference), 30-day cooldown / 2 touches / 14-day
registration-age grace. Because eligibility reads the balance
projection, a pending transaction never satisfies it and settlement
stops it automatically.

## 6. ID strategy

- Postgres PKs: `uuid` defaulting to `gen_random_uuid()` (v4).
  Time-ordered UUIDv7 was considered; it buys index locality but adds an
  app-side generation dependency — v4 is the boring correct default here.
- **Firestore IDs are preserved**, not rewritten: `animals.legacy_id`,
  `registration_submissions.legacy_id` hold the source document IDs and
  are unique. Public `/animal-adoptions/[id]` URLs resolve `legacy_id`
  first — existing links and any indexed URLs survive migration with zero
  record rewriting. New Postgres-native records expose their uuid when no
  `legacy_id` exists.

## 7. Migration phases

| Phase | What | State |
|---|---|---|
| A — infrastructure | Dependencies, schema, migrations, client, test DB | **this PR** |
| B — migration tooling | `scripts/db-migrate.ts` (schema replay), `scripts/migrate-firestore.ts` (data import, dry-run default) | **this PR** |
| C — import | Copy `animals`, `admins`, `animalRegistrations` → Postgres; idempotent, re-runnable | follow-up |
| D — reconciliation | Compare source/destination counts and sampled content | follow-up |
| E — read cutover | Public animal reads move to Postgres via `src/lib/registry/*`; Firestore keeps CMS | **done, #182** |
| F — write cutover | Registry writes move to Postgres domain services; single authoritative writer per domain | **done, #183** |
| G — retire | Firestore operational collections deny-all; runtime usage removed | **done, #183** (documents not deleted — offline cleanup) |

**Dual-write decision: avoided.** A bounded maintenance window (site
already supports `SITE_MAINTENANCE_MODE`) plus idempotent import +
reconciliation is safer than a forever dual-write with authority/failure
ambiguity. If a phase genuinely needs overlap, it must declare duration,
authority, failure semantics, and exit criteria in its own issue.

## 7a. Final authority (post-#183)

#183 completed Phases F+G. The transitional `PUBLIC_ANIMALS_SOURCE`
switch and every Firestore operational path are **gone** — there is one
authority per domain:

| Operation | Authority |
|---|---|
| Public animal list/detail/homepage preview | **Postgres** (`registry/public-animals.ts`) |
| Admin animal reads + all writes | **Postgres** (`registry/animals.ts` via `admin/animals/actions.ts`) |
| Registration submissions | **Postgres** (`animal-registration/actions.ts` → `registry/registrations.ts`) |
| Registration review | **Postgres** (`admin/registrations/actions.ts`) |
| Admin authorization | **Postgres** `admin_users` via `isAdmin()`; Firebase `admin` claim projects it to rules |
| CMS content | **Firestore** (retained) |
| Authentication/session | **Firebase Auth** (retained) |
| Receipts, team photos | **Firebase Storage** (retained); paths in Postgres |
| Audit | **Postgres** `audit_events`, transactional with mutations |

Deliberate properties:

- **No dual-write, no sync, no flag.** Postgres is the only operational
  authority; a Postgres failure fails closed (public: empty/404; admin:
  error; authz: deny) — it never silently falls back to Firestore.
- **Fail-closed visibility.** Only `adoption_status='available'` AND
  `lifecycle_status='active'` is public (`isPubliclyListed`) — enforced
  in the query AND re-checked in the service.
- **Retired collections are deny-all** in `firestore.rules` for every
  principal including claimed admins — they can never serve as an
  alternate write path. Pre-launch documents are inert; deletion is an
  offline cleanup step, not part of the deploy.
- **Admin mutations are audited** (`audit_events`, same transaction) and
  optimistic-concurrency guarded (`updated_at` expected-value check
  under `SELECT … FOR UPDATE`).

## 8. Production migration safety

`scripts/migrate-firestore.ts`:

- **dry-run by default** — reads source, prints counts, writes nothing
- requires explicit `--project=<id>` matching the configured Firebase
  project; mismatch aborts before reads
- `--execute` additionally requires `MIGRATION_CONFIRM_PROJECT=<same id>`
- Postgres target must come from `DATABASE_URL_UNPOOLED`/`DATABASE_URL`
- idempotent: upserts keyed on `legacy_id` / normalized email
- **logs counts only — never owner PII or receipt contents**

The import tooling stays useful post-cutover for rehearsal and for the
launch-time data load, but nothing in the running app reads it.

## 9. Storage boundary

Binary objects stay in Firebase Storage. Postgres stores only object
*paths* (`payment_receipt_path`, `photo_urls`) — paths are references,
not authorization. Post-#183 receipt access: the public form creates
objects under `receipts/<submission uuid>` (constrained create only);
no client-side read/update/delete exists for any principal — staff view
via short-lived signed URLs from `getReceiptUrlAction` and orphan
cleanup runs server-side in the cron sweeper. Future vet documents
follow the same pattern.

## 10. Backup / recovery (Postgres side)

Verified Neon capabilities (2026-09):

- **Instant restore (PITR)** on root branches — history window Free 6h /
  Launch up to 7d / Scale up to 30d
- **Snapshots**: manual + scheduled (paid plans); restore-from-snapshot
- **Branches**: instant copy-on-write clones — the migration rehearsal
  environment and rollback point
- **`pg_dump`** for external/long-term backups if retention beyond the
  history window is ever required

The actual provisioned project (`sfpca-db`, Vercel integration resource
`store_Z35KM1ryj86s4YOG`) is on the **Free** plan — intentionally
retained — with a 6-hour instant-restore window (1 GB cap), 1 manual
snapshot, 10 branches. Postgres is now the authoritative registry
store (#183), and the Free-plan window does **not** meet the ≥7-day
recovery target for authoritative use. This is tracked on **#180** and
is a **launch gate**: before the site goes live, Postgres recovery must
reach the agreed posture via a Neon tier upgrade or another verified
equivalent mechanism (decision deferred). A manual snapshot of `main`
remains a precondition before any production `migrate:firestore
--execute` run (RUNBOOK.md §19f).

## 11. Local dev & tests

- **PGlite** (`@electric-sql/pglite`) — real Postgres compiled to WASM,
  in-process, zero Docker/daemon/credentials. `npm run test:db` replays
  all migrations from empty and exercises constraints + the registry
  seam. Works on Windows/Node 24, CI-friendly.
- Migrations: `npm run db:generate` (schema → SQL), `npm run db:migrate`
  (apply to `DATABASE_URL_UNPOOLED` — operator-supplied Neon endpoint).
- Vercel Preview builds self-migrate: `prebuild` →
  `scripts/preview-migrate.ts` applies `drizzle/` to the preview branch
  via `DATABASE_URL_UNPOOLED` and fails the deployment on error.
  Production builds and local builds skip it — production schema changes
  are a deliberate operator step (RUNBOOK.md §19b).
- The dev server needs `DATABASE_URL` to exercise registry surfaces
  locally (a Neon dev branch or a local Postgres/PGlite wire server —
  E2E uses `tests/e2e/global-setup.ts`); unit tests need nothing.

## 12. CI

New `Postgres schema` job: `npm ci` → `db:generate` + `git diff --exit-code
drizzle/` (schema/migrations must not drift) → `npm run test:db`
(PGlite replay + integration tests). No credentials; Firebase emulator
jobs unchanged.

## 13. Environment variables

The Vercel–Neon integration (resource `sfpca-db`) provisions 16
Secret-typed variables, all scoped to **Preview + Production** only —
Development/local and CI receive none. The application canonically
uses two; the rest are integration-managed aliases kept for ecosystem
compatibility:

| Var | Scope | Source |
|---|---|---|
| `DATABASE_URL` | server-only runtime queries (pooled Neon `-pooler` host) — **required in every deployed env** | Vercel–Neon integration |
| `DATABASE_URL_UNPOOLED` | schema/data migrations (unpooled direct host) | Vercel–Neon integration |
| `CRON_SECRET` | bearer guard for `/api/cron/*` routes | operator-set (Production + Preview) |
| `RESEND_API_KEY` | Resend email delivery for `/api/cron/reminders` — unset → live runs refuse (503), dry-run still works | operator-set |
| `EMAIL_FROM` | verified sender identity, e.g. `SFPCA <reminders@…>` | operator-set |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` signing secret for `/api/webhooks/resend` — unset → route refuses all requests | operator-set |
| `ADMIN_EMAILS` | bootstrap/emergency admin allowlist — not the authz authority | operator-set |
| `MIGRATION_CONFIRM_PROJECT` | `migrate:firestore --execute` guard | operator-set |

Integration-provided aliases (unused by app code): `POSTGRES_URL`,
`POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`,
`POSTGRES_PRISMA_URL`, `POSTGRES_HOST`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DATABASE`, `PGHOST`,
`PGHOST_UNPOOLED`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`,
`NEON_PROJECT_ID`.

No `NEXT_PUBLIC_` database variables ever. Tests require none.
Actual topology, migration lifecycle, and recovery procedures are in
RUNBOOK.md §19.

## 14. Observability

Registry code uses the existing `src/lib/logger.ts` structured logging
(`logError(subsystem, operation, err)`) — Sentry picks up the same
events; no second stack. DB errors are logged by operation name; SQL
parameters and row data are never logged.

## 15. Roadmap notes (#166–#179)

Dependency findings are filed as follow-up issues. #166 (owner
registry, portal, annual confirmation) is implemented — see §5.
The schema already contains the tables the remaining issues need, so
they can proceed once the phase they depend on lands.
