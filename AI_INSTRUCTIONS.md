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
  `/animal-registration`, `/vet-services`, `/under-construction`
- **Auth**: `/login` (email/password sign-in, sign-up, reset + Google
  popup); `POST|DELETE /api/auth/session` is the only API route
- **Admin** (`/admin`, protected): dashboard, `homepage`, `animals`,
  `animal-adoptions`, `animal-registration`, `registrations`, `faq`,
  `veterinary-services`, `settings`
- **Production gate**: `SITE_MAINTENANCE_MODE=true` (Vercel Production
  only) redirects all public paths to `/under-construction`; `/login`,
  `/admin`, `/api/auth`, and static assets stay reachable

## Architectural invariants — do not casually violate

- **Server-side authorization is authoritative.** `requireAdmin()` in
  `src/app/admin/layout.tsx` verifies the session cookie (revocation
  checked) AND re-checks the `admins` collection. The edge proxy
  (`src/proxy.ts`) only checks cookie presence as a fast gate — a session
  cookie alone does not grant admin.
- **`admins/<email>` documents are the staff identity.** Document ID is
  the exact token email (rules look it up verbatim — never normalize it
  before the doc lookup). `ADMIN_EMAILS` is a bootstrap env allowlist,
  matched case-insensitively; the session route reconciles env-listed
  users into `admins/` docs so the security rules see them.
- **Verified email is required** at session creation and inside
  Firestore/Storage rules. Never trust an unverified email claim.
- **Security rules are an independent boundary.** Client-side hiding is
  not authorization; rules enforce verified-email + `admins` doc
  independently of the app.
- **Every privileged server action self-authorizes.** `use server`
  exports are HTTP-callable; each must call `requireAdmin()` itself —
  never rely on the route/UI being unreachable.
- **Session cookie:** 5-day, `httpOnly`, `secure` in production,
  `sameSite=Lax`. `/api/auth/session` rejects mutating requests whose
  `Origin` doesn't match the host (login/logout CSRF). Logout clears the
  cookie only — it does not revoke the Firebase session.
- **Roles are recorded, not enforced.** `admins/` docs carry `role`
  (`admin`/`editor`); nothing distinguishes them today — authorization
  is binary. Don't pretend granularity that doesn't exist.
- **Firestore is the content authority.** Page content, site settings,
  animals, FAQs, and registrations live in Firestore. Do not duplicate
  business/content data into source; `scripts/seed-data.json` is the
  fixture for local/test seeding.
- **Tests never touch production.** Vitest mocks boundaries; rules tests
  and Playwright E2E run against Firebase emulators only. Client
  emulator connection is gated by `NEXT_PUBLIC_USE_FIREBASE_EMULATOR`
  (set only by the E2E harness); the Admin SDK skips `cert()` only when
  emulator host env vars are set.
- **Maintenance mode is explicit.** `SITE_MAINTENANCE_MODE` is
  server-side only (never `NEXT_PUBLIC_*`) and is never inferred from
  `NODE_ENV`, branch names, or hostnames.

## Auth/session flow (actual)

`/login` signs in (email/password or Google) → browser posts the ID token
to `/api/auth/session` → server verifies the token, requires
`email_verified` and `isAdmin()` (env allowlist or `admins` doc) → issues
a 5-day HTTP-only session cookie. `/admin` layout re-verifies cookie +
admin status on every request.

## Data model (collections, from `firestore.rules`/`src/lib/types.ts`)

- `homepage/main`, `siteSettings/global`, `faq`, `vetServices`,
  `animalAdoptions` — public read, admin write
- `animals` — public reads only `status == "available"`; admin read/write.
  Admin writes must carry a supported `status` value (see lifecycle below)
- `animalRegistrations` — private submissions. Public **create**
  (unauthenticated, shape-validated, forced `status="pending"`); admin
  read/update/delete. See the submission section below
- `animalRegistration` — *different collection*: admin-only page-content
  doc that nothing currently reads (the public form hardcodes its copy
  and fees). Singular vs plural matters — do not confuse them
- `admins` — admin-only read/write
- Storage: `team-photos/` public read; admin-only image uploads
  (<5 MB, `image/*`). `images/` has **no** rule — no active workflow
  ever owned the prefix and the production namespace was verified
  empty, so it is default-deny for everyone like `animals/` below.
  `animals/` has **no** rule — animal photos
  are plain URLs on the Firestore doc and nothing uploads there, so the
  prefix is default-deny for everyone; a future animal-photo upload
  feature must add lifecycle-aware Storage rules deliberately (never
  public read of non-public animals' media). `receipts/` is private
  submission data — public create-only of small image/PDF files, admin
  read/update/delete, plus one narrow exception: an anonymous delete is
  permitted only while no `animalRegistrations/<id>` doc exists for the
  object at `receipts/<id>` (the orphan-cleanup path — see below).
  Default deny elsewhere

## Animal lifecycle (canonical)

`src/lib/animal-lifecycle.ts` is the single authoritative definition of
animal states; `firestore.rules` mirrors its public-visibility decision.
Do not compare `status` against string literals elsewhere — use the
module's predicates (`isAnimalStatus`, `isPublicAnimalStatus`).

| Status | Meaning | Public? |
|--------|---------|---------|
| `available` | Ready for adoption; listed on `/animal-adoptions` | yes — the only public state |
| `pending` | Not currently adoptable (adoption in progress or temporary hold) | no |
| `adopted` | Permanently homed; retained for historical record | no |
| unknown/missing | Malformed or unrecognized value | never — fails closed |

- Record existence is separate from visibility: non-public animals stay
  in Firestore. Hard delete exists only for erroneous/test records.
- Every supported status can transition to every other — no state is
  terminal, so staff can correct mistakes (`canTransitionAnimalStatus`).
- **Invariant: unknown or unsupported animal states are never publicly
  visible.** Firestore rules require `status == "available"` for
  unauthenticated reads, and admin writes with an unrecognized `status`
  are rejected.

## Registration submissions (canonical)

`src/lib/animal-registration.ts` is the single authoritative definition
of the submission lifecycle, field limits, the quoted fee schedule, and
receipt-file constraints; `firestore.rules` and `storage.rules` mirror
its security-relevant parts — keep all three in agreement.

**The public↔private boundary.** `/animal-registration` is the only
public submission surface. It writes `animalRegistrations` docs — owner
name/address/phone/email (PII) plus per-animal name/type/sex/isFixed —
which are **never publicly readable**. Anonymous and authenticated
non-admin reads, list queries, and probing queries are all denied at the
rules layer; only verified `admins/` members can read. There is no
adoption-application collection: `/animal-adoptions` is a read-only
listing whose CTAs point at `/contact` — do not invent one.

**Fields the public writes** (allowlisted in `isValidRegistration`):
`ownerInfo{name,address,phone,email}` (required strings with caps),
`animals` (1–25 entries), `totalFee` (0–25000), `paymentReceipt` (null or
the bound `receipts/<doc id>` path), `status` (forced `pending`),
`createdAt`/`updatedAt` (must be `request.time` server timestamps).
Rules cannot iterate the `animals` list — per-entry enums/required-ness
are enforced by the form (`validateRegistration` mirrors the rules) and
verified by staff. Individual `animalRegistrations` docs are **not**
linked to public `animals` records — registrations are independent owner
submissions.

**Receipts.** The form allocates the registration doc ID first
(`doc(collection(...))` — no write), uploads the optional file to
`receipts/<registration doc id>` (public create-only, image/PDF ≤5 MB,
no overwrites), then `setDoc`s with `paymentReceipt` equal to that
bound path — `firestore.rules` requires the path to match the doc's own
ID, so a submission can never reference another registration's receipt
or anything outside `receipts/`. The doc stores the storage *path*,
never a public URL; the admin view resolves it through `getDownloadURL`
(a bearer-token capability URL).

**Orphan receipts.** If the upload succeeds but the Firestore write
fails, the client deletes `receipts/<doc id>` — storage rules allow a
non-admin delete exactly when `animalRegistrations/<doc id>` does not
exist, so cleanup succeeds iff the write truly failed and is denied
when the document actually landed (lost response → the client treats
the submission as successful rather than retrying into a duplicate).
A denied-or-failed cleanup never produces a false success: the user
still sees the submission error and keeps their data. Residual orphans
(browser death, cleanup failure) are removed by the scheduled
`sweepOrphanedReceipts` function (every 24 h; skips objects <1 h old so
in-flight submissions are never swept). Receipt doc IDs are unguessable
auto-IDs and `receipts/` is not listable, so the conditional delete
cannot be aimed at another user's in-flight upload.

**Lifecycle:** `pending` (submitted, awaiting review) → `approved`
("Verified") or `rejected`; any supported status can move to any other
so staff can correct mistakes — nothing is terminal. Public creates can
only ever set `pending`; admin updates must keep a supported status.
Unknown/malformed statuses stay admin-visible flagged "Needs review"
rather than being coerced.

**Duplicates/retries:** deliberate — `setDoc` on a fresh allocated ID is
not idempotent and a repeat submission creates a second pending doc (the
submit button is disabled + a re-entrancy guard covers double-clicks;
staff see and can reject accidental duplicates). No content-based
dedup: two legitimate submissions can share owner details. A retry
after a failed submission allocates a new doc ID and uploads to a new
bound receipt path — it never reuses a stale receipt reference.

**Retention:** no formal retention period exists. Submissions persist
indefinitely; rules permit admin delete but no UI exposes it — deletion
is for erroneous/spam records only.

## Code conventions

- App Router only; Server Components by default, `"use client"` only
  where interactivity requires it. There is exactly one Server Actions
  file (`src/app/admin/homepage/actions.ts`); most Firestore writes go
  through the client SDK under rules enforcement — follow the pattern
  of the file you are editing
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
- shadcn/ui + Tailwind + Framer Motion (respect `shouldReduceMotion`)

## Observability (canonical)

- Log through `src/lib/logger.ts` (`logError`/`logWarn`/`logInfo`) with
  a `subsystem` + `operation`, never raw `console.error("x:", err)`.
  Errors are normalized to `errorName`/`errorCode`/`errorMessage`
  (truncated); stacks and attached objects are dropped in production.
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
- `onFirestoreChange` rebuilds only on `REBUILD_COLLECTIONS` writes;
  `animalRegistrations`/`admins` writes must not trigger deploys.
- Sentry (`@sentry/nextjs`, post-#139) captures unexpected app
  exceptions only — no Replay, tracing, profiling, or Sentry Logs.
  Init lives in `instrumentation-client.ts` / `sentry.server.config.ts`
  / `instrumentation.ts`; every event passes the privacy boundary in
  `src/lib/sentry.ts` (request data, cookies, tokens, user identity,
  console/DOM breadcrumbs, frame locals, sensitive-named keys stripped;
  emails/receipts paths/Bearer tokens redacted; expected auth
  rejections dropped). Boundary errors report once from the shared
  `ErrorFallback` — do not add `captureException` to `error.tsx`/
  `global-error.tsx` or `logger.ts`. No edge config exists — `proxy.ts`
  runs on Node.js. Sentry is inactive unless `NEXT_PUBLIC_SENTRY_DSN`
  is set; never commit real DSN/org/token values. See README's
  Observability & troubleshooting section and RUNBOOK §15.

## Testing (commands in `package.json`)

- `npm test` — Vitest unit/component (`tests/*.test.ts(x)`)
- `npm run test:rules` — Firestore/Storage rules via emulators
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
