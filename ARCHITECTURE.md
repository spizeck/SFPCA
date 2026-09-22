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
     │   │ (unchanged)        │              │ (foundation this PR;   │  │
     │   └────────────────────┘              │  cutover is Phases E-G)│  │
     │                                     └────────────────────────┘  │
     │   ┌────────────────────┐              ┌────────────────────────┐  │
     │   │ Firebase Storage   │              │ Firebase Auth          │  │
     │   │ receipts/ team-…   │              │ authentication only    │  │
     │   └────────────────────┘              └────────────────────────┘  │
     └──────────────────────────────────────────────────────────────────┘
```

## 1. Current persistence inventory (audited)

| Collection | Kind | Privacy | Readers | Writers | History? |
|---|---|---|---|---|---|
| `homepage/main` | CMS | public read | public pages (server) | admin client SDK + `admin/homepage/actions.ts` (Admin SDK) | overwritten |
| `siteSettings/global` | CMS | public read | public pages, footer, contact | admin client SDK | overwritten |
| `vetServices/main` | CMS | public read | `/vet-services` | admin client SDK | overwritten |
| `animalAdoptions/main` | CMS | public read | `/animal-adoptions` | admin client SDK | overwritten |
| `animalRegistration/main` | CMS | public read | `/animal-registration` copy | admin client SDK | overwritten |
| `faq/*` | CMS | public read | `/faq`, homepage FAQ section | admin client SDK | overwritten |
| `animals/*` | **operational** | public read iff `status=="available"`; fail-closed otherwise | `getAvailableAnimals`/`getPublicAnimal` (client SDK, server-rendered); admin list | admin client SDK | overwritten — **no history** |
| `animalRegistrations/*` | **operational, PII** | admin-only read; anonymous shape-validated create (status forced `pending`) | admin registrations page | public form (client SDK); admin client SDK | overwritten — **no history** |
| `admins/{email}` | **authz config** | admin-only | `isAdmin()` via Admin SDK; rules `isAdmin()` | Admin SDK (session route bootstrap) / console | overwritten |

Storage prefixes: `receipts/<registrationDocId>` (private PII, anonymous
create, admin read/delete, orphan-delete allowed), `team-photos/` (public
read, admin image upload <5 MB). `images/` and `animals/` are deny-all.

Firebase Auth: email/password, session cookie (`/api/auth/session`),
admin authorization = verified email in `admins/` + `ADMIN_EMAILS`
bootstrap env var.

Functions: `onFirestoreChange` → Vercel rebuild for content collections;
`triggerRebuild` (HTTP, bearer token); `sweepOrphanedReceipts` (scheduled
Storage cleanup keyed on `animalRegistrations` doc existence).

## 2. Persistence boundary

| Data | Destination | Why |
|---|---|---|
| `animals/*` | **Postgres** | Permanent registry records; ownership/registration/chip/vet relations; currently loses history on every edit |
| `animalRegistrations/*` | **Postgres** | Owner PII + payment-adjacent data; becomes `registration_submissions` + `persons` + `registrations` |
| `admins/*` | **Postgres** | Staff authorization is registry domain (`admin_users`), linked to `auth_identities` |
| `homepage`, `siteSettings`, `vetServices`, `animalAdoptions`, `animalRegistration` (page copy), `faq` | **Firestore (stays)** | Low-churn CMS content behind the rebuild-trigger pipeline; relational modeling buys nothing and would break `onFirestoreChange` → rebuild |
| `receipts/`, `team-photos/` | **Firebase Storage (stays)** | Binary objects never live in Postgres; Postgres stores path references only |
| Future: ownership, registrations, payments, chips, vet events, follow-ups, communications, audit | **Postgres** | Relational + historical by definition |

Naming convention that makes authority obvious:

- `src/lib/db/*` — Postgres schema/client/migrations (Drizzle)
- `src/lib/registry/*` — Postgres-backed domain services (server-only)
- `src/lib/firebase*.ts`, `src/lib/animals.ts`, page-content loaders —
  Firestore/CMS side
- `src/app/admin/**` may call either, but **registry writes never go to
  Firestore** once a domain has cut over

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

Current admin authorization is preserved during migration: `admin_users`
mirrors the `admins/` collection's email-keyed allowlist semantics, and
`ADMIN_EMAILS` remains the bootstrap path. Owner accounts (#166) become
`auth_identities` + `persons` rows — no second auth authority.

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
| `vet_events` | Vaccination/exam/note foundation | event-type CHECK; `valid_until` feeds future reminders |
| `follow_ups` | Due/recheck queue | status CHECK |
| `communications` | Reminder send log | `unique(idempotency_key)` — safe retries |
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
| E — read cutover | Public animal reads move to Postgres via `src/lib/registry/*`; Firestore keeps CMS | follow-up |
| F — write cutover | Registry writes move to Postgres domain services; single authoritative writer per domain | follow-up |
| G — retire | Firestore operational collections removed after verification + rollback window | follow-up |

**Dual-write decision: avoided.** A bounded maintenance window (site
already supports `SITE_MAINTENANCE_MODE`) plus idempotent import +
reconciliation is safer than a forever dual-write with authority/failure
ambiguity. If a phase genuinely needs overlap, it must declare duration,
authority, failure semantics, and exit criteria in its own issue.

## 8. Production migration safety

`scripts/migrate-firestore.ts`:

- **dry-run by default** — reads source, prints counts, writes nothing
- requires explicit `--project=<id>` matching the configured Firebase
  project; mismatch aborts before reads
- `--execute` additionally requires `MIGRATION_CONFIRM_PROJECT=<same id>`
- Postgres target must come from `DATABASE_URL_UNPOOLED`/`DATABASE_URL`
- idempotent: upserts keyed on `legacy_id` / normalized email
- **logs counts only — never owner PII or receipt contents**

This PR changes **zero** production behavior: no app code path reads
Postgres, no Firestore data is touched, no rules change.

## 9. Storage boundary

Binary objects stay in Firebase Storage. Postgres stores only object
*paths* (`payment_receipt_path`, `photo_urls`) — paths are references,
not authorization: receipt access remains governed by Storage rules
(private, admin-read) and the 56-day soft-delete posture is unchanged.
Future vet documents follow the same pattern.

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
`store_Z35KM1ryj86s4YOG`) is on the **Free** plan — 6-hour instant-restore
window. That is acceptable while Postgres holds only empty schema and
Firestore remains authoritative, but **before Phase C (#181) production
import, upgrade to Launch or take an explicit snapshot** so a bad import
can be undone beyond 6 hours. Rollback path: revert to the pre-import
snapshot/branch while Firestore remains untouched until Phase G anyway.

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
- Developers without a Neon branch need nothing: the registry is not on
  any runtime path yet.

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
| `DATABASE_URL` | server-only runtime queries (pooled Neon `-pooler` host) | Vercel–Neon integration |
| `DATABASE_URL_UNPOOLED` | schema/data migrations (unpooled direct host) | Vercel–Neon integration |
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
