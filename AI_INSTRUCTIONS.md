# AI Instructions – SFPCA Website & Admin

Orientation for coding agents working in this repository. This file states
what is true **now** — verify against code when in doubt, and keep it
updated when architecture changes. Human-facing docs: `README.md`
(overview/setup), `CONTRIBUTING.md` (workflow/tests), `SECURITY.md`
(security model).

## What this is

Next.js 16 (App Router, Turbopack) + React 19 + TypeScript site for the
Saba Foundation for the Prevention of Cruelty to Animals (SFPCA), deployed
on Vercel with Firebase (Auth, Firestore, Storage) as the backend and
Firebase Cloud Functions triggering Vercel rebuilds on every Firestore
document write (`onDocumentWritten("*")`, including non-content writes).
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
  the email address. `ADMIN_EMAILS` is a bootstrap env allowlist; the
  session route reconciles env-listed users into `admins/` docs so the
  security rules see them.
- **Verified email is required** at session creation and inside
  Firestore/Storage rules. Never trust an unverified email claim.
- **Security rules are an independent boundary.** Client-side hiding is
  not authorization; rules enforce verified-email + `admins` doc
  independently of the app.
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
- `animals` — public reads only `status == "available"`; admin read/write
- `animalRegistrations` — public **create** (unauthenticated,
  shape-validated, forced `status="pending"`); admin read/update/delete
- `animalRegistration` — *different collection*: admin-only page-content
  doc. Singular vs plural matters — do not confuse them
- `admins` — admin-only read/write
- Storage: `images/`, `animals/`, `team-photos/` public read; admin-only
  image uploads (<5 MB, `image/*`); default deny elsewhere

## Code conventions

- App Router only; Server Components by default, `"use client"` only
  where interactivity requires it. There is exactly one Server Actions
  file (`src/app/admin/homepage/actions.ts`); most Firestore writes go
  through the client SDK under rules enforcement — follow the pattern
  of the file you are editing
- `src/lib` holds Firebase init (`firebase.ts` client,
  `firebase-admin.ts` server), auth helpers (`auth.ts`), maintenance
  predicates (`maintenance.ts`), SEO helpers (`seo.ts`), and shared
  types (`types.ts`). There are no `src/services` or `src/types`
  directories
- Canonical/OG/sitemap/robots URLs come from `src/lib/seo.ts`
  (`NEXT_PUBLIC_SITE_URL`, production-domain fallback). Never use
  `VERCEL_URL` for canonical URLs — previews must not become canonical
- shadcn/ui + Tailwind + Framer Motion (respect `shouldReduceMotion`)

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
