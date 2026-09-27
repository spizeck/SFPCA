# Post-Roadmap Audit — SFPCA Registry Launch Readiness

**Audit date:** 2026-09-28
**Audited `main` SHA:** `797d263c7c43143119906080135b7ff93bf5ddb3` (merge of PR #215, Issue #179)
**Audit branch:** `docs/post-roadmap-audit`

This document is the independent end-of-roadmap assessment: what is
genuinely complete, what remains open, what actually blocks launch,
and what merely looks unfinished. Findings were verified against merged
code, migrations, security rules, CI, deployment configuration, and the
GitHub issue/PR state — not against previous reports.

---

## 1. Roadmap completion summary

The #164–#179 roadmap is **functionally complete on `main`**. Every
proposed capability shipped and is covered by tests:

| Domain | Issues / PRs | State |
|---|---|---|
| Neon/Postgres foundation + migration | #165, #184–#188 | Complete; Postgres authoritative, Firestore operational collections retired (deny-all) |
| Owner registry, households, portal, annual confirmation | #166 / #198, #211/#214 | Complete (issue closed in audit) |
| Permanent animal registry + lifecycle | #167 / #199 | Complete (closed in audit) |
| Microchip registry + scan workflow | #168 / #200 | Complete |
| Annual registrations | #169 / #201 | Complete |
| Payment ledger | #170 / #202 | Complete |
| Reminders + communications ledger | #172 / #197+ | Complete (closed in audit) |
| Vaccinations + due logic | #173 / #190, #197 | Complete (closed in audit) |
| Veterinary continuity record | #174 / #191 | Complete except document upload → #192 |
| Follow-up + clinic work queues | #175 / #193, #194 / #195 | Complete |
| Lost/found cases | #176 / #203 | Complete |
| Volunteer exception dashboard | #177 / #204 | Complete |
| Data quality + safe merge (animal, person, household) | #178 / #212, #211 / #214 | Complete |
| Anonymous reporting + staff CSV | #179 / #215 | Complete |
| Sentoo online payments | #171 | **Open — deliberately out of scope** |

Open roadmap-adjacent items that are real: #180 (backup posture),
#189 (admin maintenance bypass), #192 (clinical documents),
#130 (retention policy — owner decision), #120/#121 (dependency
maintenance), #171 (Sentoo).

## 2. Architecture coherence

The architecture survived the rapid roadmap sequence **coherently**;
each concept has one authority:

- **Animal identity ≠ registration.** `animals` is durable identity
  (uuid + `SFPCA-######` ref); `registrations` is per-animal-per-year
  authoritative records; `registration_submissions` is intake only.
  No conflation found.
- **Registration ≠ payment.** Payment state is *derived* from the
  `payments` ledger (confirmed payments − refunds + adjustments);
  registration rows carry the assessed amount + owner snapshot, never
  a payment flag. Admin UI, owner portal, reminders, and #179 reports
  all consume the same projection (`deriveRegistrationBalance` /
  `moneyByRegistration`) — no divergent money math found.
- **Person ≠ auth identity.** `auth_identities` is the only link;
  `persons` exist independently. Email match alone never grants a link
  (account-claim request → staff review). The session route provisions
  identities best-effort without locking staff out.
- **History is append-only.** Lifecycle events, payment events,
  case updates, confirmations, communications, audit events are
  immutable ledgers. Owner/registration snapshots keep point-in-time
  truth; current owner is resolved separately.
- **Merge lineage is sound.** Retired ids are unique in
  `animal_merges`/`person_merges`/`household_merges` — alias chains
  cannot form; merges reject the already-retired and refuse to orphan
  an auth identity. Nothing deletes history.
- **Reporting invents no rules.** `src/lib/registry/reports.ts`
  delegates business semantics to the canonical services (eligibility
  lifecycles, balance derivation, vaccination due-state, current-chip
  semantics); aggregates only.

**Ambiguities documented (non-blocking):**

- `vet_documents` rows can be created only by direct DB access today —
  the table + `vet-docs/` Storage reservation shipped in #174/#191
  without an uploader (#192). The prefix is deny-all, so nothing can
  leak, but the table is effectively empty until #192 lands.
- `/lost-pets` is publicly reachable and indexable but absent from the
  sitemap (`INDEXABLE_PATHS`). Plausibly deliberate for fast-moving
  sensitive listings, but it is undocumented either way.
- "Postgres schema" CI job exists but is **not** in the required
  ruleset checks ("Protect main" requires Next.js app, Firebase
  Functions, Firebase security rules, E2E smoke). A migration-drift or
  replay failure would show red on the PR but would not block merge.

## 3. Schema & migration audit

- **19 migrations** (`drizzle/0000`–`0018`) replay cleanly — the whole
  `tests/db` suite (414 tests) runs against PGlite after replaying them,
  and CI additionally proves `drizzle-kit generate` produces zero drift
  from `schema.ts`.
- **Invariants enforced in the DB, not the app:** closed status
  vocabularies (lifecycle, registration, payment, case, request,
  communication, follow-up), `unique(animal_id, year)` for
  registrations, partial uniques for current chip assignments and open
  cases, `num_nonnulls=1` for ownership party, money-shape CHECKs,
  provider-consistency CHECK on payments, idempotency-key uniques on
  payments and communications.
- **FK posture is history-preserving:** restrictive deletes on every
  domain FK (nothing cascade-erases history); `set null` only for
  actor-identity references where the event survives the actor.
- **Lifecycle history** keys on `effective_on` (real-world date), not
  insertion time — a documented correction is a new event, never an
  update.
- **No abandoned scaffold tables.** The one transitional table
  (`found_reports`) was explicitly dropped in migration 0016 when
  `lost_found_cases` superseded it. `vet_documents` is provisioned
  ahead of its uploader — intentional, secured by CHECK + deny-all
  Storage prefix.

## 4. Authorization & security

Verified server-side; nothing relies on UI hiding:

- **All 17 admin action/route files self-authorize** via
  `requireAdmin()` — including the CSV export route handler, which is
  outside layout protection by Next.js design.
- **Admin layout** redirects unauthorized users; the site-wide proxy
  redirects anonymous `/admin`/`/portal` to `/login` before handlers
  run.
- **Owner portal isolation:** `requireOwner` resolves session →
  identity → person; every animal-scoped action re-verifies current
  ownership via `getOwnedOwnership`. Client-supplied ids are never
  proof. Unlinked identities see a pending-claim state only.
- **Retired identities cannot regain access:** person merges refuse
  inputs holding auth links; login clears stale `admin` claims for
  demoted users; `ADMIN_EMAILS` is bootstrap-only and never rewrites a
  staff-managed role.
- **Route handlers:** session route enforces same-origin +
  `email_verified` and fails closed; both crons require
  `CRON_SECRET` bearer (unset = 401); the Resend webhook is
  svix-signature-verified (unset = 503); the Functions rebuild trigger
  compares its token in constant time.
- **Firestore rules:** CMS collections public-read/admin-claim-write;
  all retired operational collections deny-all; default deny.
- **Storage rules:** `team-photos/` public-read/admin-write;
  `receipts/` constrained public create, zero client read/update/delete
  for anyone (staff use server-minted signed URLs); `vet-docs/` and
  everything else deny-all. No catch-all write path exists.
- **Editor vs admin roles** are recorded but authorization is binary
  (`isAdmin`) — consistent, documented, acceptable for this org size.
- A real Firebase Admin SDK key exists locally in the repo directory
  (`*-firebase-adminsdk-*.json`) — **verified git-ignored and never
  committed**. Standard local-dev posture.

## 5. Privacy audit

PII lives in: `persons`, `registration_submissions`, owner snapshots on
`registrations`, `payments` (staff labels), `communications` (recipient
snapshots), `ownership*` history, `receipts/` objects, Firebase Auth
accounts, `audit_events` actor labels, and Vercel runtime logs
(bounded by the logger's no-payload rule).

- **Public read surfaces are explicit DTOs:** public animal listing
  (`PUBLIC_COLUMNS` allowlist), `/lost-pets` (name/photo/species/
  location/note only), `/statistics` (aggregate-only anonymous DTO).
- **#179 public boundary independently verified:** suppression runs
  server-side before the DTO is built; non-zero cells < 5 render as
  "Fewer than 5"; complementary suppression blocks subtraction;
  rates require denominator ≥ 5; E2E asserts seeded owner
  name/email/phone/address/chip never reach the DOM.
- **Sentry** scrubs emails, receipt paths, bearer tokens, headers,
  cookies, bodies, and any key matching a broad sensitive pattern;
  `sendDefaultPii` off; LocalVariables integration removed.
- **#130 status:** open owner decision — widened by the audit comment
  (Postgres persons/submissions + receipts + auth accounts, not just
  the retired Firestore collection). No retention period exists and
  none should be invented by engineering.

## 6. Clinical documents (#192)

**Status: partially provisioned, feature absent.** The `vet_documents`
table exists with a `storage_path ~ '^vet-docs/'` CHECK; the prefix is
deny-all in Storage rules; the animal profile lists document rows and
merges reparent them. Missing: the upload/download path (signed-URL or
proxied route), Storage rules for staff access, size/type validation at
upload, orphan sweep, and tests. The issue's own scope is accurate.

**Launch classification:** blocks *clinical-document functionality
only*. The veterinary continuity record works without it. Nothing else
depends on it. **Not a site blocker.**

## 7. Backup & recovery (#180)

**Verified:** Neon project provisioned + Vercel-integrated; preview
branch isolation physically verified; preview self-migration works;
the point-in-time restore drill (RUNBOOK §19e) **executed successfully**
2026-09-22 — Neon PITR genuinely works on this project.

**The gap:** Neon Free instant-restore covers **6 hours** (1 GB cap) +
1 manual snapshot. The documented target is ≥7 days (former Firestore
posture: 7-day PITR + weekly backups). This was explicitly gated on
#183 — **which has now merged**, making the gap live. RUNBOOK §19f was
updated in this audit to reflect that Postgres is authoritative.

**Firestore/Storage:** 7-day PITR + managed backups enabled and
documented (RUNBOOK §17); Storage object recovery procedure documented.

**Verdict:** acceptable *today* only because the registry holds no real
data. **Must be resolved — or the risk explicitly accepted by the
owner — before real registrations/payments/vet history are accepted.**
Options: Neon plan with ≥7-day PITR, scheduled `pg_dump` to durable
storage, or an accepted equivalent. This is the single most important
pre-real-data item.

## 8. Maintenance mode & launch controls (#189)

- Gate is server-side, env-exact (`SITE_MAINTENANCE_MODE === "true"`),
  fails closed, and correctly exempts `/login`, `/admin`, `/portal`,
  `/api/auth`, static assets, and the Under Construction page's own
  metadata assets. robots.txt disallows all under maintenance; the
  sitemap empties. Launch = deleting the Production env var — a
  deliberate config change.
- **#189 is still valid:** authenticated admins cannot preview public
  routes under the gate (the proxy only sees cookie *presence*, not
  admin-ness). Not a launch blocker — launch removes the gate — but it
  limits real-production testing while gated. Post-launch enhancement.
- **New finding → #216:** under maintenance, `/api/cron/*` and
  `/api/webhooks/resend` are **not** exempt — the gate redirects them,
  silently suspending reminders, receipt sweeps, and delivery
  writebacks for the whole window. Harmless pre-launch; a real
  coherence bug if maintenance is ever re-enabled post-launch.

## 9. Email / reminder readiness (#172)

Implemented end-to-end: scheduled daily evaluation (vercel.json cron,
fail-closed `CRON_SECRET`), four evaluator classes (registration-due,
payment-due, annual-confirmation, vaccination) with policy cadences and
cooldowns, idempotency keys collapsing retries, communication ledger
with `queued→sending→sent→delivered/failed` states, signature-verified
Resend webhook writeback, opt-out honoring for optional kinds only,
staff visibility via `/admin/communications` + dashboard exception row
+ manual requeue, and an operator `?dry_run=1` mode.

**Launch prerequisites (ops, unverifiable from repo):** `RESEND_API_KEY`,
`EMAIL_FROM` (verified sender domain — see SPF_SETUP.md),
`RESEND_WEBHOOK_SECRET` + endpoint registration in Resend,
`CRON_SECRET`. Without the provider env vars the cron refuses cleanly
(503) — no silent queueing.

## 10. Financial integrity (#170)

The ledger is canonical and complete for the manual-payment world:
assessed amount frozen on the registration row; payments are
provider-neutral ledger rows (`payment|refund|adjustment` ×
`pending|confirmed|failed|void`); only confirmed money settles;
refunds/adjustments are linked rows, not edits; `payment_events` is the
append-only reconciliation history; idempotency keys + partial uniques
prevent double-apply; `waived`/`complimentary`/`no-fee`/`unpaid`/
`partial`/`paid` are derived, never stored. Overpayment resolves to
`paid` with a visible overage; cancelled registrations keep their
ledger. Admin UI, portal, reminders, reports, and exports all derive
from the same functions. Sentoo (#171) is a provider seam
(`initiateProviderPayment`/`reconcileProviderOutcome` already exist) —
remains open by design.

## 11. Observability

- Sentry: server + browser init with PII scrubbing, `sendDefaultPii`
  off, sourcemaps uploaded + deleted from bundle, environment tagging,
  release tracking, `onRequestError` coverage, staff-only
  `/admin/sentry-check` verification page. Alerting configured per
  #140.
- **Gap → #218:** caught failures logged via `logError` reach only
  Vercel runtime logs. Compensating controls exist for business-visible
  failures (dashboard exception rows, ledger states) but
  infrastructure-level failures inside caught paths have no push
  channel. Post-launch improvement, not a blocker.
- Structured logging has a documented no-PII rule and normalizes
  errors before emit.

## 12. Accessibility / mobile / SEO

- axe coverage asserts zero critical/serious WCAG 2.2 violations on 8
  public routes + consent UI, dark theme, keyboard flows, mobile
  overflow. **Gap → #217:** `/statistics`, `/lost-pets`, `/portal`
  postdate the suite and are unscanned.
- SEO coherent: sitemap excludes gated/admin/auth surfaces, empties
  under maintenance; robots disallow-all under maintenance;
  `/under-construction` noindex but crawlable; admin + portal carry
  `NOINDEX_ROBOTS`; canonical/OG metadata per public page.
- New surfaces are responsive by construction (grids collapse; the
  reporting E2E exercises 375px); tables are native `<table>` markup.

## 13. Tests & CI

| Layer | Coverage | Verdict |
|---|---|---|
| Unit/component (861 tests) | domain vocabulary, auth, payments math, lifecycle, merge safety, reports suppression/CSV, SEO, maintenance matrix, email policy | Strong |
| PGlite DB (414 tests) | every service against replayed real migrations — constraints, merge reparenting, ledger, queues, reports | Strong |
| Emulator rules (34 tests) | Firestore + Storage authorization incl. deny-all retired collections and receipt privacy | Strong |
| E2E (102 tests) | auth, portal, registration lifecycle incl. payment/refund, chip lookup, lost/found, merges, reminders, reports incl. CSV download + anonymous-export denial, a11y, SEO, hydration | Strong |
| CI gates | required: Next.js app (lint/typecheck/test/build), Functions, rules, E2E smoke. Postgres schema runs but is not required | **Recommend adding "Postgres schema" to the Protect main ruleset** |

## 14. Deployment / environment inventory

| Variable | Purpose | State |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Neon pooled/unpooled | Documented provisioned (Vercel–Neon integration) |
| `NEXT_PUBLIC_FIREBASE_*` (6) | client SDK | Documented |
| `FIREBASE_ADMIN_*` (4) | Admin SDK | Documented |
| `ADMIN_EMAILS` | bootstrap admin allowlist | Documented; bootstrap-only |
| `CRON_SECRET` | cron auth | Required for cron execution — verify set in Vercel |
| `RESEND_API_KEY`, `EMAIL_FROM` | reminder delivery | Required before reminders go live — unverifiable from repo |
| `RESEND_WEBHOOK_SECRET` | webhook auth | Required for delivery writeback |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_AUTH_TOKEN/ORG/PROJECT` | monitoring | #140 configured; verify values still live in Vercel |
| `NEXT_PUBLIC_GTM_ID` | analytics behind consent | Documented |
| `SITE_MAINTENANCE_MODE` | launch gate | Set in Production — this IS the launch switch |
| `NEXT_PUBLIC_SITE_URL` | canonical URLs | Documented |
| `REBUILD_TRIGGER_TOKEN` (Functions) | CMS rebuild auth | Functions env |

Dependabot preview deploys are disabled in `vercel.json` (#213) — no
preview-infrastructure spend on dependency PRs.

## 15. Operational workflow walkthrough

Traced against the shipped services + E2E journeys — volunteers are
not trapped anywhere requiring raw DB access for ordinary mistakes:

- **Intake → register:** public form → `registration_submissions` →
  staff queue → `createRegistration` (one per animal/year; fee assessed
  + frozen; owner snapshot preserved).
- **Payment:** manual record → confirm → refund/adjust; pending never
  settles; void available; overpayment shown.
- **Mistake correction:** `cancelRegistration` (correction/withdrawn
  reasons), `correctRegistrationAmount`, refund, lifecycle correction
  (any state → any state via history), animal edit. Merges are
  deliberately irreversible — preview/compare UI exists; recovery is an
  ops event (acceptable: merges are rare + audited).
- **Owner-side:** portal confirmation, change *requests* (never direct
  mutation), missing reports, profile self-service, claim flow via
  staff review.
- **Exception work:** dashboard composes unregistered animals, unpaid
  registrations, open cases, follow-ups, conflicts, failed comms — each
  a link to a work surface, not a raw table.

## 16. Launch classification

### Must resolve before public launch
- **None.** The site is safe to open to the public today: maintenance
  flip is a config change, privacy boundaries hold, authz is enforced
  server-side everywhere, and public surfaces ship only DTOs.

### Must resolve before accepting REAL registry/financial/veterinary data
1. **#180 — recovery posture.** 6-hour Neon Free PITR + 1 manual
   snapshot is below the documented ≥7-day target now that Postgres is
   authoritative. Resolve (upgrade/scheduled dumps) or get explicit
   owner risk-acceptance. *The single most important item.*
2. **Production env verification (ops, ~30 min):** confirm in Vercel —
   `DATABASE_URL*` (Prod scope), `CRON_SECRET`, `RESEND_API_KEY`,
   `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET` + Resend endpoint registered,
   Sentry vars, `ADMIN_EMAILS` bootstrap. All documented in RUNBOOK §2
   and #180's checklist.
3. **Seed the first admin + provision owner/test data policy:** decide
   what pre-launch fixture/test data gets wiped before real use.

### Can launch with the feature disabled
- **#192 clinical documents** — vet record works without uploads.
- **#171 Sentoo** — manual ledger is the working payment path.
- **#189 admin maintenance bypass** — matters only pre-launch/while gated.

### Post-launch improvements
- #216 cron/webhook exemption under maintenance (edge case).
- #217 axe coverage extension; #218 operational alerting channel.
- #219 intake throttling (honeypot/rate limit) if abuse materializes.
- #120 ESLint 10 (still blocked: dep. PRs #206/#208 fail), #121
  Tailwind v4, dependabot majors #210 (Sentry 11), #124 (TS 7).
- Recommend making the "Postgres schema" CI check required.
- Owner self-serve communication preferences (currently staff-recorded).

### Owner decisions required
- **#130** PII retention/deletion policy (widened scope — see comment).
- **#180** acceptable recovery mechanism + plan tier.
- Whether `/lost-pets` should be sitemap-listed.
- Which dependabot PRs to merge now (#207 minor-patch + #209 dotenv are
  green; the rest fail and need real work).

## 17. GitHub reconciliation performed

**Closed (evidence-based):** #164 (epic — all decomposed work merged;
Sentoo tracked in #171), #166, #167, #172, #173, #174 (document upload
→ #192), #182 (read cutover shipped #187/#188).

**Left open with classification:**
- #171 Sentoo — post-launch feature.
- #180 — real pre-real-data gate; audit comment added.
- #189 — valid enhancement; post-launch.
- #192 — valid, feature-scoped; not a site blocker.
- #130 — owner policy decision; scope comment added.
- #120/#121 — maintenance; #120's blockers still hold (dependabot
  ESLint-10 PRs fail).

**Created:** #216 (maintenance gate intercepts cron/webhook),
#217 (axe coverage for new surfaces), #218 (caught errors don't reach
Sentry), #219 (public intake throttling).

## 18. Recommended execution order

1. Resolve #180 recovery posture (or record owner acceptance).
2. Verify production env vars + register the Resend webhook.
3. Clear disposable test data; seed the first real admin.
4. (Optional) ship #216's two-line exemption.
5. Flip `SITE_MAINTENANCE_MODE` off in Production.
6. Post-launch: #217, #218, #192, mergeable dependabot PRs (#207/#209),
   then the deferred majors.

## 19. Validation performed for this audit

`main` @ `797d263`: lint 0 errors (5 pre-existing warnings),
type-check clean, 861 unit tests, 414 PGlite tests (full migration
replay), 34 rules tests, production build clean (all 47 routes),
102 E2E passing. CI on the last roadmap PR (#215): all checks green +
Vercel preview deployed.

## 20. Bottom line

> **If SFPCA wanted to begin using this system with real data tomorrow,
> one thing stops us: the recovery posture (#180).** Six-hour
> point-in-time recovery on a Free-plan database that now holds the
> authoritative record of animals, owners, payments, and veterinary
> history is a thin safety net — resolve it or consciously accept it.
> Everything else is either already done, an owner policy decision, or
> an ordinary post-launch improvement. The architecture is coherent,
> the security and privacy boundaries are real, and the code is in
> better shape than the issue tracker was.
