# SFPCA Website

A modern web application for the **Saba Foundation for the Prevention of Cruelty to Animals (SFPCA)** — serving the island of Saba in the Caribbean Netherlands.

Built with Next.js 16, TypeScript, Tailwind CSS, and Firebase.

**Documentation map:** this file covers overview, setup, architecture,
and commands. [CONTRIBUTING.md](CONTRIBUTING.md) is the canonical
development/testing workflow. [SECURITY.md](SECURITY.md) covers the
security model and dependency practices.
[AI_INSTRUCTIONS.md](AI_INSTRUCTIONS.md) gives coding agents a concise
orientation and the architectural invariants.
[ACCESSIBILITY.md](ACCESSIBILITY.md) records the public-site accessibility
audit baseline and remaining exceptions.
[RUNBOOK.md](RUNBOOK.md) is the production deployment and recovery
runbook (release checklist, Firebase/rules deploys, maintenance mode,
rollbacks). `functions/README.md` covers the Cloud Functions project.

## Features

### Public Website
- **Homepage** with hero video, about section, services, adoptable animals, donations, FAQ, and contact
- **FAQ Page** with categorized, expandable questions (dynamically managed via admin)
- **Animal Adoptions** page with filterable listings
- **Animal Registration** public intake form (submissions land in admin review)
- **Veterinary Services** page
- **Contact Page** with contact info, map embed, and social links
- **Under Construction** placeholder for pages in development — also the
  production maintenance gate (see Deployment)
- **SEO Optimized** with Open Graph, Twitter cards, JSON-LD structured data, sitemap, and robots.txt
- **Responsive Design** — mobile-first with Tailwind CSS
- **Dark/Light Mode** via next-themes

### Admin Dashboard (`/admin`)
- **Homepage Editor** — edit hero, about, services, donation, and team sections
- **Animal Management** — full CRUD for adoption listings
- **FAQ Management** — add, edit, delete FAQs by category (syncs to homepage + FAQ page)
- **Veterinary Services** — manage vet service content
- **Animal Adoptions** — manage adoption page content
- **Animal Registration** — view and verify submitted registrations
- **Site Settings** — update contact info, social media links, map embed
- **Team Photo Uploads** — Firebase Storage integration with loading states

### Security
- Email/password or Google sign-in; admin sessions are HTTP-only cookies
  (5-day expiry) created by `/api/auth/session`
- Verified email required at session creation and inside security rules
- Admin authorization is enforced server-side in the `/admin` layout
  (`requireAdmin()`); the edge proxy is only a fast unauthenticated gate
- Firestore/Storage security rules are an independent enforcement
  boundary (verified email + `admins` document)
- Admin allowlist via the `admins` Firestore collection, bootstrapped by
  the `ADMIN_EMAILS` environment variable

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| Animation | Framer Motion |
| Backend | Firebase (Auth, Firestore, Storage) |
| Icons | Lucide React |
| Deployment | Vercel |

## Getting Started

### Prerequisites

- Node.js 24 and npm (see `.nvmrc` / `package.json` `engines`; Firebase Functions also deploys on Node 24)
- Firebase project with Authentication, Firestore, and Storage enabled
- Firebase service account key (for server-side admin SDK)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/spizeck/SFPCA.git
   cd SFPCA
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env.local
   ```
   Fill in your Firebase credentials (see `.env.example` for all required variables).

4. **Set up Firebase**
   - Enable Email/Password and Google sign-in in Firebase Authentication
   - Create a Firestore database
   - Enable Firebase Storage
   - Deploy security rules:
     ```bash
     firebase deploy --only firestore:rules
     firebase deploy --only storage
     ```

5. **Add yourself as an admin**
   
   In the Firestore console, create a document in the `admins` collection with your email as the document ID.

6. **Run the development server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
SFPCA/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── admin/                    # Admin dashboard (protected by layout)
│   │   │   ├── animals/              # Animal management
│   │   │   ├── animal-adoptions/     # Adoption page editor
│   │   │   ├── animal-registration/  # Registration page editor
│   │   │   ├── faq/                  # FAQ management
│   │   │   ├── homepage/             # Homepage editor
│   │   │   ├── registrations/        # View submitted registrations
│   │   │   ├── settings/             # Site settings
│   │   │   ├── veterinary-services/  # Vet services editor
│   │   │   └── page.tsx              # Admin dashboard
│   │   ├── api/auth/session/         # Session cookie create/delete (only API route)
│   │   ├── animal-adoptions/         # Public adoptions page
│   │   ├── animal-registration/      # Public registration intake form
│   │   ├── contact/                  # Contact page
│   │   ├── faq/                      # FAQ page
│   │   ├── login/                    # Login page
│   │   ├── under-construction/       # Placeholder / maintenance gate page
│   │   ├── vet-services/             # Public veterinary services page
│   │   ├── layout.tsx                # Root layout with metadata
│   │   ├── page.tsx                  # Public homepage
│   │   ├── robots.ts                 # SEO robots.txt
│   │   └── sitemap.ts               # SEO sitemap
│   ├── proxy.ts                      # Edge request gate (maintenance + /admin cookie check)
│   ├── components/
│   │   ├── admin/                    # Admin components (nav, team manager)
│   │   ├── animal-adoptions/         # Adoption page components
│   │   ├── animal-registration/      # Registration form components
│   │   ├── contact/                  # Contact page components
│   │   ├── faq/                      # FAQ page components
│   │   ├── homepage/                 # Homepage section components
│   │   ├── ui/                       # shadcn/ui components
│   │   └── veterinary-services/      # Vet services components
│   ├── hooks/                        # Custom React hooks
│   └── lib/                          # Utilities
│       ├── firebase.ts               # Firebase client config
│       ├── firebase-admin.ts         # Firebase admin SDK config
│       ├── auth.ts                   # Auth helpers
│       ├── animals.ts                # Animal data helpers
│       ├── animations.ts             # Framer Motion utilities
│       ├── seo.ts                    # Canonical URL, sitemap/robots, metadata helpers
│       ├── types.ts                  # TypeScript types
│       └── utils.ts                  # General utilities
├── tests/                            # Test suites (see Testing)
│   ├── *.test.ts(x)                  # Vitest unit/component tests
│   ├── *.test.mjs                    # Emulator security-rules tests
│   └── e2e/                          # Playwright browser smoke tests
├── functions/                        # Firebase Cloud Functions (Vercel rebuild triggers)
├── scripts/                          # seed.ts + seed-data.json, deploy helpers
├── .github/workflows/ci.yml          # CI quality gates
├── playwright.config.ts              # E2E config (emulator-backed)
├── firestore.rules                   # Firestore security rules
├── storage.rules                     # Firebase Storage security rules
├── .env.example                      # Environment variable template
└── package.json
```

## Firestore Collections

| Collection | Description |
|-----------|-------------|
| `homepage` | Homepage content (doc: `main`) — hero, about, services, donation, team |
| `siteSettings` | Contact info, social links, map embed (doc: `global`) |
| `animals` | Animal listings — `status` controls public visibility (canonical lifecycle: `src/lib/animal-lifecycle.ts`) |
| `faq` | FAQ entries with category, question, answer, and display order |
| `animalRegistration` | Registration **page content** (admin-managed, singular; currently not read by the public form) |
| `animalRegistrations` | Submitted registration forms — private owner data (public create → `pending`, admin-only read; canonical lifecycle/schema: `src/lib/animal-registration.ts`) |
| `admins` | Admin user allowlist (email as document ID) |
| `vetServices` | Veterinary services page content |
| `animalAdoptions` | Animal adoptions page content |

## Admin Access

1. Navigate to `/login`
2. Sign in with email/password or Google using an authorized,
   email-verified account
3. You will be redirected to `/admin` if authorized

Authorization requires a verified email **and** either an
`admins/<email>` Firestore document or an entry in the `ADMIN_EMAILS`
environment variable (the session route copies env-listed users into the
`admins` collection on first login). To add an admin, create a document
in the `admins` collection with the user's email as the document ID, or
add the email to `ADMIN_EMAILS`.

## Deployment

The full release/recovery procedure — topology, per-component deploy
commands, pre-release and smoke checklists, maintenance mode, rollbacks,
and incident decision paths — lives in [RUNBOOK.md](RUNBOOK.md). This
section is the short version.

**Data recovery:** Firestore resilience is Google-managed only — PITR +
scheduled backups, no application-level backup code. Current production
state, the enable commands, and the restore procedure are in
[RUNBOOK.md §17](RUNBOOK.md). Firebase Storage objects (registration
receipts, team photos) are **not** covered by Firestore backups — they
rely on the bucket's native soft-delete instead; see §17e for the
boundary and §18 for the Storage procedure.

### Vercel

1. Push code to GitHub
2. Import the project in [Vercel](https://vercel.com)
3. Add all environment variables from `.env.example` in the Vercel dashboard
4. Deploy

### Maintenance mode

The production public site can be gated behind `/under-construction` while
`/login`, `/admin`, the auth session API, and framework/static assets stay
reachable.

- **Enable (production only):** set `SITE_MAINTENANCE_MODE=true` in the
  Vercel **Production** environment and redeploy.
- **Preview & local development:** leave the variable unset — the full site
  remains usable for feature development and PR review.
- **Reopen the site:** remove the variable (or set it to `false`) in the
  Vercel Production environment and redeploy.

The flag is server-side only (never `NEXT_PUBLIC_*`) and is evaluated per
request in `src/proxy.ts`. It is never inferred from `NODE_ENV`, branch
names, or hostnames.

### SEO, sitemap, and social metadata

- `NEXT_PUBLIC_SITE_URL` is the canonical public origin (falls back to the
  production domain). Canonical links, Open Graph URLs, `sitemap.xml`, and
  `robots.txt` all derive from it via `src/lib/seo.ts` — never from
  `VERCEL_URL`, so preview deployments can never become canonical.
- Metadata defaults live in `src/app/layout.tsx`; public pages set
  title/description/canonical through `pageMetadata()` in `src/lib/seo.ts`.
- `/login`, `/admin/**`, and `/under-construction` are `noindex`.
- While maintenance mode is on, `robots.txt` disallows everything and the
  sitemap is empty; normal rules resume automatically when it lifts.
- The social share image is generated at build time
  (`src/app/opengraph-image.tsx`, `src/app/twitter-image.tsx`) — no static
  asset to maintain.
- `Organization` JSON-LD in the root layout contains only verified facts.

### Firebase Rules

After any changes to security rules:
```bash
firebase deploy --only firestore:rules
firebase deploy --only storage
```

### Firebase Functions

`functions/` contains three Cloud Functions:

- `onFirestoreChange` — a real write to a *content* collection
  (`homepage`, `siteSettings`, `animals`, `faq`, `vetServices`,
  `animalAdoptions`, `animalRegistration`) triggers a Vercel rebuild via
  a deploy hook; writes to `animalRegistrations`/`admins` change no
  public page and are skipped before logging
- `triggerRebuild` — HTTP endpoint that triggers a rebuild manually
- `sweepOrphanedReceipts` — scheduled (every 24 h); deletes
  `receipts/<id>` objects with no matching `animalRegistrations/<id>`
  document, skipping objects under 1 hour old. This is the fail-safe
  for receipt uploads whose registration write and immediate client
  cleanup both failed — private data is never left orphaned
  indefinitely

They need `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` in `functions/.env`
(see `functions/README.md`). Deploy with:

```bash
npm run deploy:functions   # or: cd functions && firebase deploy --only functions
```

## Observability & troubleshooting

Observability is layered: **Sentry** collects unexpected Next.js
application exceptions (browser + server) centrally; **Vercel** keeps
runtime/deployment logs including the app's structured `#94` logging;
**Firebase/Google Cloud** covers Cloud Functions; **GitHub Actions** is
the build/test gate. Sentry supplements — it never replaces — the
Vercel/Firebase log streams.

Sentry is **error monitoring only**: no Session Replay, no profiling,
no performance tracing, no feedback widgets, no request-body capture.
The SDK initializes only when `NEXT_PUBLIC_SENTRY_DSN` is set — without
it the app behaves exactly as before (no events, no network calls).
When configured, events pass through a deliberate privacy boundary
(`src/lib/sentry.ts`) that strips request headers/cookies/bodies/query
strings, user identity, server hostnames, breadcrumbs that echo console
output or form interaction, and any context/extra key that looks
sensitive — then redacts emails, bearer tokens, and `receipts/` paths
from remaining message text. Expected auth rejections (expired/invalid
tokens) are dropped, not reported.

**Where errors and logs live:**

| Surface | Location |
|---------|----------|
| Unexpected app exceptions (browser render errors, server exceptions) | Sentry → Issues (grouped by release/environment) |
| Next.js server (session route, server actions, RSC fetches, render errors) | Vercel → Project → Logs (Runtime) |
| Cloud Functions (`onFirestoreChange`, `triggerRebuild`, `sweepOrphanedReceipts`) | Firebase console → Functions → Logs, or Google Cloud Logging (`resource.type="cloud_function"`) |
| Vercel deploys (incl. hook-triggered rebuilds) | Vercel → Deployments |
| CI checks | GitHub → PR checks / Actions |

**Log shape.** App code emits one JSON object per event via
`src/lib/logger.ts` (`logError`/`logWarn`/`logInfo`) with `subsystem`,
`operation`, `outcome`, and normalized `errorName`/`errorCode`/
`errorMessage` fields — never raw payloads. Functions emit the same
fields via `firebase-functions/logger`. Expected outcomes (denied
login, expired cookie, invalid form) are **not** error-level events.

**Never logged or sent to Sentry:** owner names/emails/phones/
addresses, registration fields or receipt paths/IDs, receipt contents,
ID tokens, session cookies, `Authorization` headers,
`REBUILD_TRIGGER_TOKEN`, the Vercel deploy-hook URL, service-account
keys, env values. Sentry events carry only sanitized technical context
(route, runtime, subsystem, release, environment, error type, Next.js
digest) — never user identity or request data.

### Troubleshooting

- **Public site down/broken** → Vercel deployment status first, then
  Vercel runtime logs for `subsystem:"content"` fetch errors; check
  Firebase status page if Firestore errors dominate. A hard page crash
  shows "Something went wrong" + a `Reference:` digest — search Vercel
  logs for that digest, and (once Sentry is configured) the Sentry
  issue tagged `nextjs.error_digest` with the same value.
- **Admin can't load / gets bounced to login** → distinguish:
  deployment (Vercel), auth (browser sign-in toast), session
  (`subsystem:"session"` errors in Vercel logs — e.g.
  `errorCode:"auth/internal-error"` = Firebase problem, expected denials
  log at warn), admin lookup (`operation:"admin-lookup"` errors =
  Firestore down), or missing config (`missing env var(s)
  FIREBASE_ADMIN_*` — set them in Vercel env, never logged values).
- **Content rebuild didn't happen** → check in order: Functions logs
  for `operation:"firestore-trigger"` (did the write fire?), then
  `operation:"vercel-hook"` (`outcome:"skipped"` = missing
  VERCEL_TOKEN/VERCEL_PROJECT_ID; `outcome:"failed"` + `httpStatus`/
  `errorCode` = hook rejected or network), then Vercel Deployments (did
  a deploy start/fail?). Writes to `animalRegistrations`/`admins`
  correctly trigger nothing.
- **Manual rebuild failed** → 403 = wrong/missing
  `REBUILD_TRIGGER_TOKEN` (never logged); 503 = hook env not
  configured; 500 = upstream request failed — see `vercel-hook` error
  log for `httpStatus`/`errorCode`.
- **Registration submission failing** → the user sees a generic toast.
  Maintainer checks: form validation errors are client-side only;
  `permission-denied` means Firestore rules rejected the shape
  (`firestore.rules` is the authority); `storage/*` codes mean the
  receipt upload path. Firebase outage → check Firebase status. Never
  log or inspect the submission's PII to diagnose.
- **Receipt cleanup failed** → Functions logs for
  `subsystem:"receipt-cleanup"`: each run logs counts (`scanned`,
  `deleted`, `skippedRecent`, `skippedMalformed`, `failed`). A run
  ending `outcome:"partial-failure"` (or a failed execution) means some
  orphans remain — the next daily run retries them; investigate the
  `errorCode` on the per-object warn entries.
- **CI failing** → `Next.js app` = lint/types/unit/build; `Firebase
  Functions` = functions lint/unit/export shape; `Firebase security
  rules` = emulator rules tests; `E2E smoke` = Playwright journeys.

### Maintainer must configure in production

Nothing below can be committed to the repo — configure in consoles:

- **Sentry** → create the project, then set `NEXT_PUBLIC_SENTRY_DSN`
  (runtime), `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN`
  (source-map upload at build time), and optionally
  `NEXT_PUBLIC_SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` in Vercel env —
  see RUNBOOK §15 for scoping and the post-config verification
  procedure (admin-only `/admin/sentry-check` fires controlled
  synthetic errors through the real capture paths). Until configured
  the app runs normally and sends nothing.
- **Vercel** → project Settings → Notifications: enable deployment-
  failure notifications (email/Slack) so failed rebuilds page someone.
- **Google Cloud** → Logging → Log-based alerts: alert on
  `resource.type="cloud_function" AND severity>=ERROR`. Fires on failed
  rebuild triggers and failed sweeps. Threshold philosophy: alert on
  sustained/repeated failures, not single transient events — Functions
  already retries nothing, so one ERROR entry is one real failure.
- **Firebase console** → Functions → Health: glance at error rate when
  anything seems off.
- **Uptime:** no synthetic `/health` endpoint exists by design — it
  would test little, cost reads, and widen the attack surface. Vercel
  deployment health + CI E2E + the checks above are the baseline; add
  an external uptime monitor on the public homepage URL only if SFPCA
  wants down-detection between deploys.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run type-check` | TypeScript type checking |
| `npm test` | Vitest unit/component tests (CI-safe) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:maintenance` | Focused maintenance-gate tests |
| `npm run test:rules` | Firestore/Storage rules tests (emulators, needs Java) |
| `npm run test:e2e` | Playwright browser smoke tests (emulators, needs Java) |
| `npm run test:e2e:headed` | E2E suite with a visible browser |
| `npm run seed` | Seed Firestore with `scripts/seed-data.json` |
| `npm run deploy:functions` | Deploy Firebase Functions with env checks |

## Testing

Four layers, kept separate on purpose — see CONTRIBUTING.md for details:

- **Vitest** (`npm test`) — unit/component tests in `tests/*.test.ts(x)`;
  no credentials or emulators needed
- **Security rules** (`npm run test:rules`) — Firestore/Storage rules
  against the Firebase emulator suite (`tests/*.test.mjs`)
- **E2E smoke** (`npm run test:e2e`) — Playwright Chromium journeys in
  `tests/e2e/` against Auth/Firestore emulators; orchestrates everything
  itself, never touches production
- **Maintenance tests** — folded into the Vitest suite; also runnable
  alone via `npm run test:maintenance`

## CI

`.github/workflows/ci.yml` runs four jobs on every PR and push to `main`:
`Next.js app` (lint, type-check, unit tests, build), `Firebase
Functions` (lint, export validation), `Firebase security rules`
(emulator tests), and `E2E smoke` (Playwright). All run on Node 24 from
`.nvmrc`; no production secrets are used.

## Environment Variables

`.env.example` (root) and `functions/.env.example` are the canonical,
placeholder-only variable lists. Categories:

- **Public config** (shipped to the browser, not secrets):
  `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_GTM_ID`, `NEXT_PUBLIC_SITE_URL`
- **Server-only secrets** (never commit): `FIREBASE_ADMIN_*`,
  `ADMIN_EMAILS`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`
- **Behavior flags** (server-only): `SITE_MAINTENANCE_MODE` (production
  gate, see Deployment); `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` is set only
  by the E2E harness — never set it for real deployments

Analytics runs through Google Tag Manager (`NEXT_PUBLIC_GTM_ID`), which
is injected only after the visitor grants analytics consent in the Klaro
banner — see `src/lib/consent.ts`. GA4 itself is configured inside the
GTM container. The old direct `NEXT_PUBLIC_GA_ID` loading was removed in
#116; do not reintroduce it or add tracking scripts outside the consent
boundary. Users can revisit their choice via "Cookie settings" in the
footer, and the privacy policy lives at `/privacy`.

## License

Proprietary — &copy; 2025 SFPCA. All rights reserved. See [LICENSE](LICENSE).

## Contact

Saba Foundation for the Prevention of Cruelty to Animals  
Email: sfpcasaba@gmail.com  
Phone: +599 416 7947
