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
audit baseline and remaining exceptions. `functions/README.md`
covers the Cloud Functions project.

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
| `animals` | Adoptable animal listings with photos, status, species |
| `faq` | FAQ entries with category, question, answer, and display order |
| `animalRegistration` | Registration **page content** (admin-managed, singular) |
| `animalRegistrations` | Submitted registration forms (public create → `pending`, plural) |
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

`functions/` contains two Cloud Functions that keep the deployed site in
sync with Firestore content:

- `onFirestoreChange` — any real document write triggers a Vercel rebuild
  via a deploy hook (skips no-op writes)
- `triggerRebuild` — HTTP endpoint that triggers a rebuild manually

They need `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` in `functions/.env`
(see `functions/README.md`). Deploy with:

```bash
npm run deploy:functions   # or: cd functions && firebase deploy --only functions
```

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
  `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_SITE_URL`
- **Server-only secrets** (never commit): `FIREBASE_ADMIN_*`,
  `ADMIN_EMAILS`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`
- **Behavior flags** (server-only): `SITE_MAINTENANCE_MODE` (production
  gate, see Deployment); `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` is set only
  by the E2E harness — never set it for real deployments

Google Analytics loads when `NEXT_PUBLIC_GA_ID` is set; there is
currently no consent-management layer.

## License

Proprietary — &copy; 2025 SFPCA. All rights reserved. See [LICENSE](LICENSE).

## Contact

Saba Foundation for the Prevention of Cruelty to Animals  
Email: sfpcasaba@gmail.com  
Phone: +599 416 7947
