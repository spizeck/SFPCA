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
| `animals` (Postgres) | **operational** | public iff `lifecycle_status='available'` | `src/lib/registry/public-animals.ts` (public DTO); `registry/animals.ts` (admin) | `admin/animals/actions.ts` server actions |
| `registration_submissions` (Postgres) | **operational, PII** | admin-only; never public | `registry/registrations.ts` | `animal-registration/actions.ts` (public intake); `admin/registrations/actions.ts` (review) |
| `admin_users` (Postgres) | **authz config** | server-only | `registry/admin-users.ts` → `isAdmin()` | `provisionAdminUser` (session route, insert-only) / SQL |
| `vaccinations` (Postgres) | **operational, medical** | admin-only; never public | `registry/vaccinations.ts` | `admin/animals/[id]/actions.ts` server actions |
| `audit_events` (Postgres) | **audit** | server-only | (append-only) | domain services, transactional with mutations |
| Firestore `animals`/`animalRegistrations`/`admins` | **retired** | deny-all in rules for every principal | — none — | — none — |

Storage prefixes: `receipts/<submission uuid>` (private PII — public
constrained create only; no client read/update/delete for anyone; staff
view via server-minted signed URLs; orphan cleanup via Admin SDK sweep),
`team-photos/` (public read, admin-claim image upload <5 MB). `images/`
and `animals/` are deny-all.

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
| Future: ownership, registrations, payments, chips, vet events, follow-ups, communications, audit | **Postgres** | Relational + historical by definition |

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
logins. Owner accounts (#166) become `auth_identities` + `persons` rows —
no second auth authority.

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
| `animals` | Permanent animal identity | `unique(legacy_id)`; species/sex/lifecycle CHECKs; **no** registration/payment columns |
| `ownerships` | Historical animal↔person/household | exactly one of person/household (`num_nonnulls=1`); `valid_to > valid_from` |
| `registration_submissions` | Intake events (today's `animalRegistrations`) | `unique(legacy_id)`; owner contact snapshot; receipt **path** only |
| `registrations` | Per-animal per-year record | `unique(animal_id, year)` |
| `payments` | Provider-neutral ledger | integer cents + currency; kind/status CHECKs; no cascade deletes |
| `microchip_records` | Chip assignments w/ history | partial `unique(chip_number) WHERE assigned_to IS NULL` — one active assignment |
| `vet_events` | General/unstructured vet history (exam, treatment, surgery, note) | event-type CHECK; structured vaccinations live in `vaccinations` |
| `vaccinations` | Structured vaccination history (#173) | restrictive FK to `animals`; `due_on`/`valid_until` ≥ `administered_on`; due-state derived, never stored |
| `follow_ups` | Manual recheck queue (#175) | status CHECK; vaccination due-ness is derived — not materialized here |
| `communications` | Reminder send log | `unique(idempotency_key)` — safe retries; `vax-reminder:<vax>:<date>:<touch>` keys (#173) |
| `audit_events` | Append-only mutation history | entity type/id + before/after jsonb |

**Where invariants live:** DB constraints — identity uniqueness, FK
integrity, closed status vocabularies, ownership ranges, money shape.
Domain services — lifecycle transitions, dedupe, reminder scheduling.
UI validation — form shape only, never trusted.

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
- **Fail-closed visibility.** Only `lifecycle_status='available'` is
  public — enforced in the query AND re-checked in the service.
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
| `CRON_SECRET` | bearer guard for `/api/cron/sweep-receipts` | operator-set (Production + Preview) |
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

Dependency findings are filed as follow-up issues; nothing in #166–#179
is implemented here. The schema already contains the tables each issue
needs (see §5), so they can proceed once the phase they depend on lands.
