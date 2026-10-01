# AI Instructions – SFPCA Website & Admin

Orientation for coding agents working in this repository. This file states
what is true **now** — verify against code when in doubt, and keep it
updated when architecture changes. Human-facing docs: `README.md`
(overview/setup), `CONTRIBUTING.md` (workflow/tests), `SECURITY.md`
(security model), `RUNBOOK.md` (production deploy/rollback — never run
its `firebase deploy` commands from an agent session without explicit
instruction).

## What this is

Next.js 16 (App Router, Turbopack) + React 19 + TypeScript site for the
Saba Foundation for the Prevention of Cruelty to Animals (SFPCA), deployed
on Vercel with Firebase (Auth, Firestore, Storage) as the backend and
Firebase Cloud Functions triggering Vercel rebuilds on every Firestore
document write (`onDocumentWritten("*")`, including non-content writes).
The manual `triggerRebuild` HTTP function is gated by
`Authorization: Bearer <REBUILD_TRIGGER_TOKEN>` and refuses all requests
when the token is unset.
**Node 24** is canonical (`.nvmrc`, `engines`, Functions runtime, CI).

## Application surfaces

- **Public pages**: `/`, `/contact`, `/faq`, `/animal-adoptions`,
  `/animal-registration`, `/vet-services`, `/statistics` (anonymous
  aggregate registry stats, #179), `/under-construction`
- **Auth**: `/login` (email/password sign-in, sign-up, reset + Google
  popup); `POST|DELETE /api/auth/session` is the only API route
- **Admin** (`/admin`, protected): dashboard, `homepage`, `animals`,
  `animal-adoptions`, `animal-registration`, `registrations`, `faq`,
  `veterinary-services`, `settings`, `chip-lookup` (found-animal scan
  workflow, #168 — owner contact is staff-only via authorized server
  actions), `reports` (#179 — aggregate metrics workspace + audited CSV
  export; public counterpart is `/statistics`, a separate suppressed DTO)
- **Production gate**: `SITE_MAINTENANCE_MODE=true` (Vercel Production
  only) redirects all public paths to `/under-construction`; `/login`,
  `/admin`, `/api/auth`, and static assets stay reachable

## Architectural invariants — do not casually violate

- **Server-side authorization is authoritative.** `requireAdmin()` in
  `src/lib/auth.ts` verifies the session cookie (revocation
  checked) AND re-checks the Postgres `admin_users` table. The edge
  proxy (`src/proxy.ts`) only checks cookie presence as a fast gate — a
  session cookie alone does not grant admin.
- **Postgres `admin_users` rows are the staff identity.** Emails are
  normalized (`trim().toLowerCase()`) and matched case-insensitively —
  `findAdminUser` compares against `lower(admin_users.email)`, which a
  `lower(email)` unique index keeps unambiguous. `ADMIN_EMAILS` is a
  bootstrap env allowlist, matched case-insensitively; the session
  route reconciles env-listed users into `admin_users` rows
  (insert-only — a provisioned row's role is staff-managed and never
  rewritten by env config) and sets the `admin`/`adminRole` custom
  claims that Firestore/Storage rules consult for client-SDK writes.
  The Firestore `admins` collection is retired/deny-all.
- **Verified email is required** at session creation and inside
  Firestore/Storage rules. Never trust an unverified email claim.
- **Security rules are an independent boundary.** Client-side hiding is
  not authorization; rules enforce verified-email + the `admin` custom
  claim independently of the app.
- **Every privileged server action self-authorizes.** `use server`
  exports are HTTP-callable; each must call `requireAdmin()` itself —
  never rely on the route/UI being unreachable.
- **Session cookie:** 5-day, `httpOnly`, `secure` in production,
  `sameSite=Lax`. `/api/auth/session` rejects mutating requests whose
  `Origin` doesn't match the host (login/logout CSRF). Logout clears the
  cookie only — it does not revoke the Firebase session.
- **Roles are recorded, not enforced.** `admin_users` rows carry `role`
  (`admin`/`editor`); nothing distinguishes them today — authorization
  is binary. Don't pretend granularity that doesn't exist.
- **Two authorities, by domain.** Firestore remains the CMS/content
  authority (page content, site settings, FAQs). Postgres (Neon, via
  Drizzle) is the foundation for the **registry domain** — animals,
  people/households, ownership, registrations, payments, chips,
  vaccinations, veterinary records (encounters, procedures, medications,
  alerts, weights, documents), follow-ups, communications, audit. The boundary and migration
  plan are in `ARCHITECTURE.md`. New registry-domain data goes to
  `src/lib/db`/`src/lib/registry` — **never into Firestore**. The
  Firestore `animals`/`animalRegistrations`/`admins` collections are
  fully retired: deny-all for every principal in `firestore.rules`, no
  read or write path exists in the app.
  `scripts/seed-data.json` is the fixture for local/test seeding.
- **Owner reminders are a real pipeline (#172).** `communications` is
  the authoritative ledger: evaluators (`src/lib/registry/reminders.ts`)
  queue rows under deterministic idempotency keys, the cron route drains
  them through Resend, and webhooks refine outcomes. Only reminder kinds
  with an authoritative eligibility source may register an evaluator —
  never fabricate eligibility from intake snapshots or `updated_at`.
  Tests must never send real email: inject a fake `EmailSender`.
- **Tests never touch production.** Vitest mocks boundaries; rules tests
  and Playwright E2E run against Firebase emulators only. Client
  emulator connection is gated by `NEXT_PUBLIC_USE_FIREBASE_EMULATOR`
  (set only by the E2E harness); the Admin SDK skips `cert()` only when
  emulator host env vars are set.
- **Maintenance mode is explicit.** `SITE_MAINTENANCE_MODE` is
  server-side only (never `NEXT_PUBLIC_*`) and is never inferred from
  `NODE_ENV`, branch names, or hostnames.
- **Reporting never overclaims or leaks (#179).** Registry counts are
  "animals known to SFPCA" — the total island population is unknown and
  must never be estimated or implied. Public statistics come only from
  `getPublicStats`'s anonymous DTO with `PUBLIC_SMALL_CELL_MIN`
  suppression (single canonical threshold in `src/lib/reports.ts`);
  staff export is `requireAdmin`-gated, audited, aggregate-only CSV.

## Auth/session flow (actual)

`/login` signs in (email/password or Google) → browser posts the ID token
to `/api/auth/session` → server verifies the token, requires
`email_verified`, resolves `isAdmin()` (env allowlist or Postgres
`admin_users`), and issues a 5-day HTTP-only session cookie. Admins get
an `admin_users` row provisioned and `admin`/`adminRole` custom claims
set (non-admins get the claim cleared so a removed admin's rules-side
access ends on the next token refresh); every verified login also
materializes an `auth_identities` row and runs owner-link provisioning.
`/admin` layout re-verifies cookie + admin status on every request.

## Data model (collections, from `firestore.rules`/`src/lib/types.ts`)

- `homepage/main`, `siteSettings/global`, `faq`, `vetServices`,
  `animalAdoptions`, `animalRegistration` — public read, admin write
  (page-content docs; copy only — fees/workflows live in code)
- `animals` — **Postgres** is authoritative (#183); the Firestore
  collection is retired/deny-all. Public reads see only
  `adoption_status == "available"` AND `lifecycle_status == "active"`
  via redacted DTOs (`src/lib/registry/public-animals.ts`); admin
  read/write goes through `src/lib/registry/animals.ts` server actions.
  Admin writes must carry a supported `adoption_status` (see lifecycle
  below). The public detail route `/animal-adoptions/[id]` renders
  per-request and 404s any non-public animal — never reveal that a
  private animal exists
- `animalRegistrations` — **retired/deny-all** for every principal.
  Registration intake lives in Postgres (`registration_submissions`)
  via the `submitRegistrationAction` server action — never write to
  this collection. See the submission section below
- `animalRegistration` — *different collection* from the plural:
  page-content doc read by the public registration page. Singular vs
  plural matters — do not confuse them
- `admins` — **retired/deny-all**. Staff identity is Postgres
  `admin_users`; rules-side client writes ride on the `admin` custom
  claim the session route sets
- Storage: `team-photos/` public read; admin-claim-only image uploads
  (<5 MB, `image/*`). `images/` has **no** rule — no active workflow
  ever owned the prefix and the production namespace was verified
  empty, so it is default-deny for everyone like `animals/` below.
  `animals/` has **no** rule — animal photos
  are plain URLs on the Postgres `animals` row and nothing uploads
  there, so the prefix is default-deny for everyone; a future
  animal-photo upload feature must add lifecycle-aware Storage rules
  deliberately (never public read of non-public animals' media).
  `vet-docs/` allows create-only for the verified `admin` claim
  (image/PDF, strictly <5 MiB — the storage rule uses `<`, tighter than
  the app's `≤5 MiB` `VET_DOC_MAX_BYTES` validator, so an exactly-5-MiB
  file passes `isVetDocumentFile` but is rejected by the rule);
  reads/deletes go through server-side Admin SDK only. `receipts/` is private submission data and **deny-all for the
  client SDK** — uploads transit the server route
  `/api/receipts/[submissionId]` (see below) and staff read via
  short-lived signed URLs from `getReceiptUrlAction`.
  Default deny elsewhere

## Animal lifecycle (canonical, #167)

`src/lib/animal-lifecycle.ts` is the single authoritative definition of
BOTH vocabularies — they are deliberately separate. Do not compare
statuses against string literals elsewhere — use the module's
predicates (`isAnimalLifecycleStatus`, `isAnimalAdoptionStatus`,
`isPubliclyListed`).

**Registry lifecycle** (`animals.lifecycle_status`) — the animal's real
state; never public; changed only through `transitionAnimalLifecycle`
in `src/lib/registry/animals.ts`, which writes the
`animal_lifecycle_events` history row and the audit row in the same
transaction:

| Status | Meaning |
|--------|---------|
| `active` | Living on Saba / in registry care (the default) |
| `deceased` | Confirmed dead — terminal in fact, still correctable |
| `moved-off-saba` | Confirmed to have left Saba |
| `unknown` | Record exists but living/on-island status unconfirmed |

Every state can transition to every other (`canTransitionAnimalLifecycle`)
— corrections are new history rows, not rewrites. `deceased` and
`moved-off-saba` are ownership-ending: the transition closes ALL open
ownership intervals (co-owners included) and cancels open follow-ups /
clinic expectations in the same transaction.

**Adoption listing** (`animals.adoption_status`) — the public catalog
switch, freely staff-editable:

| Status | Meaning | Public? |
|--------|---------|---------|
| `not-listed` | Not in the adoption program (the default) | no |
| `available` | Listed: homepage preview + `/animal-adoptions` | yes* |
| `pending` | Adoption in progress or temporarily held | no |
| `adopted` | Permanently homed; kept for historical record | no |

*Public visibility requires BOTH `adoption_status='available'` AND
`lifecycle_status='active'`.

- Record existence is separate from visibility: a non-public animal
  stays in the registry. Hard delete exists only for erroneous/test
  records and is blocked by restrictive FKs on any domain history.
- **Invariant: unknown or unsupported animal states are never publicly
  visible** — `isPubliclyListed` fails closed on malformed values.

## Registration submissions (canonical)

`src/lib/animal-registration.ts` is the single authoritative definition
of the submission lifecycle, field limits, the quoted fee schedule, and
receipt-file constraints; the intake server action and receipt route
enforce them server-side — keep all three in agreement.

**The public↔private boundary.** `/animal-registration` is the only
public submission surface. The browser calls `submitRegistrationAction`
(`src/app/animal-registration/actions.ts`) — a server action that
re-validates the payload and inserts a `registration_submissions`
Postgres row — owner name/address/phone/email (PII) plus per-animal
name/type/sex/isFixed. The browser never reaches Postgres directly and
there is no unauthenticated read path: admin review goes through
`requireAdmin()`-gated actions in
`src/app/admin/registrations/actions.ts`. There is no
adoption-application collection: `/animal-adoptions` is a read-only
listing whose CTAs point at `/contact` — do not invent one.

**Abuse controls (#219).** Honeypot first (a hit returns a fake success
so the field can't be probed as a bot oracle), then a Postgres-backed
fixed-window rate limit keyed by a salted hash of the trusted client IP
(`src/lib/request-identity.ts` documents the header trust boundary;
raw IPs are never stored). Over-limit attempts get an honest retryable
`throttled` result. Public creates can only ever carry `pending`.

**Fields the public submits** (re-validated server-side by
`createRegistrationSubmission` against `REGISTRATION_FIELD_LIMITS`):
owner contact fields, `animals` (bounded list), declared total fee, and
`receiptRequested` (intent to attach a receipt — persisted so the
upload route can refuse rows that never asked for one). Submissions are
**not** linked to public `animals` records — staff match them to
registry animals explicitly via `createRegistrationFromSubmissionAction`.

**Receipts.** No direct unauthenticated Storage writes — `storage.rules`
denies every client access to `receipts/`. After the row lands, the
browser POSTs the file to `/api/receipts/[submissionId]`, which
rate-limits, atomically claims the row's `payment_receipt_path` slot
(`claimReceiptSlot`), reads a bounded body, validates type from the
bytes' magic bytes (image/PDF ≤5 MB), and writes **create-only**
(`ifGenerationMatch: 0`) through the Admin SDK. The row stores the
storage *path*, never a public URL; staff resolve it through
`getReceiptUrlAction` (10-minute signed URL, `receipts/`-prefixed paths
only, no `..`).

**Orphan claims/objects.** An upload failure releases the slot claim
(`releaseReceiptSlot`); a process death leaves a dangling claim, which
the daily `/api/cron/sweep-receipts` Vercel cron (06:00 UTC, Bearer
`CRON_SECRET`) clears — and sweeps storage objects no submission row
claims — after a one-hour grace window (`src/lib/registry/receipt-sweep.ts`).
Submission IDs are unguessable UUIDs and `receipts/` is not listable
through the client SDK.

**Lifecycle:** `pending` (submitted, awaiting review) → `approved`
("Verified") or `rejected`; `updateSubmissionStatus` permits any
supported-status transition so staff can correct mistakes — nothing is
terminal. Unknown/malformed statuses stay admin-visible flagged
"Needs review" rather than being coerced. Approval creates no
authoritative record — staff must still create the `registrations` row
explicitly (see below).

**Duplicates/retries:** two different policies live on the same path.
`createRegistrationSubmission` is idempotent on `submissionId` — a
repeated insert of the same ID resolves to the existing row rather
than erroring. The form, though, mints a fresh `crypto.randomUUID()`
on every submit click, so a user retry after a failed submission
creates a second `pending` row by design (the submit button is
disabled while in flight; staff see and can reject accidental
duplicates). No content-based dedup: two legitimate submissions can
share owner details. Receipt upload is the opposite shape: a retry
targets `/api/receipts/[submissionId]` on the **existing** row — the
route re-claims the released receipt slot rather than creating a new
submission.

**Retention:** no formal retention period exists — the policy question
is #130. Submissions persist indefinitely.

## Authoritative registrations (canonical, #169)

`registration_submissions` is **intake** — the applicant's claim. The
authoritative record is `registrations` (one row per animal per year,
`unique(animal_id, year)`, status `active`/`cancelled` only). Staff
explicitly create it after reviewing a submission; approval of a
submission never silently registers an animal, and submission approval
is not proof of payment.

`src/lib/registrations.ts` is the shared vocabulary: period helpers
(`currentRegistrationYear(asOf)` — calendar-year periods, never
hard-code a year), `derivePaymentState`, status/resolution/payment-state
unions. `src/lib/registry/registrations.ts` is the server-only domain
service (create/cancel/resolve/correct/notes, `listUnregisteredAnimals`
— THE current-period eligibility source shared by the staff queue,
portal, and #172's `registration-due-reminder` — and
`getRegistrationQueues`). `src/lib/registry/payments.ts` is the
ledger seam: payment state is derived from `confirmed` `payments` rows
plus the row's `resolution` — never a stored flag. Waivers/
complimentary are `resolution` values, not $0 payments; corrections
carry before/after in `audit_events`. Animal lifecycle, registration
status, and payment state are separate concepts — no code path may
infer one from another.

## Code conventions

- App Router only; Server Components by default, `"use client"` only
  where interactivity requires it. Server Actions live in `actions.ts`
  files next to their routes (`src/app/admin/**`, `src/app/portal`,
  public intake) and **each self-authorizes** — `requireAdmin()` for
  staff surfaces, `requireOwner()` for the portal — never rely on the
  route being unreachable. CMS Firestore writes (homepage, settings,
  FAQs, team photos) go through the client SDK under rules enforcement
  (verified `admin` claim); all registry mutations go through Postgres
  server actions — follow the pattern of the file you are editing
- `src/lib` holds Firebase init (`firebase.ts` client,
  `firebase-admin.ts` server), auth helpers (`auth.ts`), maintenance
  predicates (`maintenance.ts`), SEO helpers (`seo.ts`), the animal
  lifecycle definition (`animal-lifecycle.ts`), the registration
  submission lifecycle/schema (`animal-registration.ts`), the logging
  convention (`logger.ts`), public animal queries (`animals.ts`), and
  shared types (`types.ts`). There are no `src/services` or `src/types`
  directories
- Canonical/OG/sitemap/robots URLs come from `src/lib/seo.ts`
  (`NEXT_PUBLIC_SITE_URL`, production-domain fallback). Never use
  `VERCEL_URL` for canonical URLs — previews must not become canonical
- shadcn/ui + Tailwind + Framer Motion. Reduced motion is handled via
  `useReducedMotion()` on `transition` props only — `initial`/`animate`/
  `whileInView`/`exit` must stay identical between server and first client
  render or hydration mismatches leave content hidden (see
  `src/lib/animations.ts`)
- Tailwind CSS v4, CSS-first: `src/app/globals.css` is the entire styling
  configuration — there is no `tailwind.config.*`. The `:root`/`.dark`
  HSL-triplet variables are the single source of truth for semantic
  tokens; the `@theme inline` block at the top maps each to a
  `--color-*`/`--radius-*` key, so `bg-background`, `text-destructive`,
  `ring-ring/50`, `rounded-md` etc. resolve `hsl(var(--…))` at runtime and
  follow the `.dark` re-declarations. To add/change a semantic token:
  declare the triplet in `:root` and `.dark`, then add the `--color-*`
  bridge in `@theme inline`. Never hard-code palette values for semantic
  usage. Dark mode is class-based via `@custom-variant dark` — `dark:`
  utilities follow next-themes' `.dark` class on `<html>`, not
  `prefers-color-scheme`. Enter/exit animations on Radix surfaces come
  from `tw-animate-css` (`@import` in globals.css; suppressed under
  `prefers-reduced-motion` there). PostCSS wiring is
  `postcss.config.js` → `@tailwindcss/postcss`; content detection is
  automatic — do not re-add a config file or a safelist.

## Observability (canonical)

- Log through `src/lib/logger.ts` (`logError`/`logWarn`/`logInfo`) with
  a `subsystem` + `operation`, never raw `console.error("x:", err)`.
  Errors are normalized to `errorName`/`errorCode`/`errorMessage`
  (truncated); stacks and attached objects are dropped in production.
  `logError` also reports the exception to Sentry — it is reserved for
  genuinely unexpected caught failures; never use it for expected
  outcomes. Callers must not add their own `Sentry.captureException`
  around handled errors — pass the real `Error` to `logError` and let
  the centralized path report it (opt out only when the site captures
  itself, via `{ sentry: false }`).
- Functions use `firebase-functions/logger` with the same field shape.
- Never log: owner PII, registration fields, receipt paths/IDs, doc
  contents, tokens, cookies, `Authorization`, the Vercel hook URL,
  `REBUILD_TRIGGER_TOKEN`, env values, service-account keys.
- Expected rejections (denied login, expired cookie, invalid form,
  unauthorized probes) are warn-level at most — they are not incidents.
- Error boundaries: `src/app/error.tsx` + `src/app/global-error.tsx`
  share `src/components/error-fallback.tsx`; the Next `error.digest`
  is the correlation handle into server logs. Do not add per-route
  copies without a distinct need.
- `onFirestoreChange` rebuilds only on `REBUILD_COLLECTIONS` writes —
  an allowlist of CMS collections. The retired registry collections
  (`animals`/`animalRegistrations`/`admins`) are deny-all anyway, but
  nothing registry-side may ever trigger a deploy: registry writes go
  to Postgres, not Firestore.
- Sentry (`@sentry/nextjs`, post-#139) captures unexpected app
  exceptions only — no Replay, tracing, profiling, or Sentry Logs.
  Init lives in `instrumentation-client.ts` / `sentry.server.config.ts`
  / `instrumentation.ts`; every event passes the privacy boundary in
  `src/lib/sentry.ts` (request data, cookies, tokens, user identity,
  console/DOM breadcrumbs, frame locals, sensitive-named keys stripped;
  emails/receipts paths/Bearer tokens redacted; expected auth
  rejections and "Unauthorized" action denials dropped). Boundary
  errors report once from the shared `ErrorFallback` — do not add
  `captureException` to `error.tsx`/`global-error.tsx`; caught
  operational errors report through `logError` — do not add
  `captureException` at call sites. No edge config exists — `proxy.ts`
  runs on Node.js. Sending requires a DSN AND a real Vercel deployment
  (or `SENTRY_ENABLE_LOCAL=true`): `resolveSentryRuntime()` in
  `src/lib/sentry.ts` is the single environment/send decision —
  VERCEL_DEPLOYMENT_ID/VERCEL_REGION prove Vercel infrastructure, so a
  pulled `.env.local` (VERCEL_ENV="production") can never report as
  production (#235). next.config.ts injects the resolved result into
  the client bundle; never let the client read VERCEL_ENV or
  NEXT_PUBLIC_SENTRY_ENVIRONMENT directly. Never commit real
  DSN/org/token values. Controlled
  verification lives at `/admin/sentry-check` (admin-gated, nav →
  System): a browser throw contained by a dedicated boundary that
  renders the shared `ErrorFallback` (same capture path as
  app/error.tsx), a server action that re-checks `requireAdmin()`
  itself — server actions are POST endpoints, never rely on layout
  auth — and a caught `logError` path (#218). See README's
  Observability & troubleshooting section and RUNBOOK §15.
- Consent & analytics (post-#116): Klaro is the consent layer; GTM is
  the only tag-loading mechanism and is injected only after affirmative
  analytics consent. `src/lib/consent.ts` owns Consent Mode v2
  defaults/updates (`analytics_storage` only; `ad_*` always denied),
  the `sfpca-consent` localStorage key, and the one-shot
  `sfpca-gtm-script` injector. Never add direct `gtag`/GA scripts or
  third-party tags outside this boundary; future tags go inside the GTM
  container. Consent UI mounts once in `layout.tsx`; users reopen it via
  the footer "Cookie settings" button. `NEXT_PUBLIC_GTM_ID` must be a
  direct `process.env.NEXT_PUBLIC_GTM_ID` reference for client-side
  inlining (same constraint as the Sentry DSN, #147). Sentry is
  operational monitoring — never gate it behind analytics consent. See
  RUNBOOK §16.
- Data recovery (post-#135): Firestore resilience is Google-managed
  only — PITR + scheduled backups on `(default)` in `saba-sfpca`. Never
  build app-level backup code (no export crons, no JSON dumps in Git,
  no second database). Restores always create a NEW database — recover
  surgically, never in place, and verify `--project=saba-sfpca` before
  any modifying command. Firestore backups do NOT cover Storage objects
  (`receipts/`, `team-photos/`) — the bucket's native soft-delete covers
  those; never add versioning/copy jobs alongside it. See RUNBOOK §17-18.

## Testing (commands in `package.json`)

- `npm test` — Vitest unit/component (`tests/*.test.ts(x)`)
- `npm run test:rules` — Firestore/Storage rules via emulators
- `npm run test:db` — Postgres registry schema/migration tests via
  PGlite (in-process real Postgres; no Docker or credentials needed)
- `npm run db:generate` / `npm run db:migrate` — drizzle schema → SQL /
  apply to `DATABASE_URL_UNPOOLED`
  (`tests/*.test.mjs`, needs Java)
- `npm run test:e2e` — Playwright Chromium smoke suite (`tests/e2e/`),
  orchestrates emulators + dev server + fixtures itself (needs Java)
- CI jobs: `Next.js app`, `Firebase Functions`, `Firebase security
  rules`, `E2E smoke`

## When editing

- Keep `AI_INSTRUCTIONS.md`, `README.md`, `CONTRIBUTING.md`, and
  `SECURITY.md` truthful when you change architecture — docs drift is a
  known problem in this repo
- Never commit credentials; `.env.example` files are the canonical
  variable lists (placeholders only)
- Small, boring, maintainable changes; assume non-technical admin users
