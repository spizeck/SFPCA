# Production Runbook — Deployment & Recovery

How to release and recover the SFPCA site. Pair this with the
observability baseline in [README.md → Observability &
troubleshooting](README.md#observability--troubleshooting), which covers
*where to look* when something is broken; this file covers *what to do*
about it.

Every command below is verified against this repository. Where a step
lives in a web console and cannot be verified from the repo, it is
marked **[console]** — confirm the exact button/page names in the
current dashboard UI rather than trusting this doc blindly.

## 1. Production topology

```
GitHub (main)
  │  merge/push
  ▼
Vercel Git integration ──► Next.js build ──► production deployment
  ▲                                            (saba-sfpca domain)
  │ deploy hook (VERCEL_TOKEN / VERCEL_PROJECT_ID)
  │
Firestore CMS write ──► onFirestoreChange ──► deploy hook POST
(authenticated HTTPS)   ──► triggerRebuild ──► same deploy hook
Vercel cron (daily)     ──► /api/cron/sweep-receipts ──► Storage cleanup
Vercel cron (daily)     ──► /api/cron/reminders ──► evaluate → queue → send (Resend)
Resend webhook          ──► /api/webhooks/resend ──► delivered/bounced/failed onto rows

Firebase deploy (manual, CLI):
  functions/  ──► Cloud Functions (rebuild triggers only)
  firestore.rules / firestore.indexes.json ──► Firestore
  storage.rules ──► Cloud Storage
```

**Deployments are independent.** Merging to `main` deploys the Next.js
app only. Firebase Functions, Firestore rules, and Storage rules deploy
only via `firebase deploy` — a Vercel deploy never touches them, and a
`firebase deploy` never touches Vercel. Firebase Hosting is **not**
configured (no `hosting` key in `firebase.json`); Vercel serves
everything.

## 2. Components and ownership

| Component | Source | Platform | Deploy trigger | Status visible at | Runtime failures at |
|-----------|--------|----------|----------------|-------------------|---------------------|
| Next.js app | repo root (`src/`) | Vercel | automatic on merge to `main` [console: confirm production branch] | Vercel → Deployments | Vercel → Logs (Runtime) |
| `onFirestoreChange` | `functions/index.js` | Cloud Functions v2 | manual `firebase deploy` | `firebase deploy` output / Firebase console → Functions | Cloud Logging, `subsystem:"rebuild"` |
| `triggerRebuild` | `functions/index.js` | Cloud Functions v2 | manual `firebase deploy` | same | Cloud Logging |
| Receipt sweep | `src/app/api/cron/sweep-receipts/route.ts`, `src/lib/registry/receipt-sweep.ts` | Vercel cron (`vercel.json`, daily 06:00 UTC) | automatic with Vercel deploy | Vercel → Deployments → Cron / Functions logs | Vercel → Logs, `subsystem:"receipt-cleanup"`; partial failures return 500 |
| Reminder send | `src/app/api/cron/reminders/route.ts`, `src/lib/registry/reminders.ts`, `src/lib/registry/communications.ts` | Vercel cron (`vercel.json`, daily 12:00 UTC = 08:00 AST) | automatic with Vercel deploy | Vercel → Deployments → Cron; `/admin/communications` | Vercel → Logs, `subsystem:"communications"`; 503 when provider unconfigured |
| Resend webhook | `src/app/api/webhooks/resend/route.ts` | Resend dashboard (endpoint + signing secret) | manual provider config | Resend dashboard → Webhooks | signature failures → 400; no secret → 503 |
| Firestore rules | `firestore.rules` | Firestore | manual `firebase deploy --only firestore:rules` | Firebase console → Firestore → Rules | denied requests surface as `permission-denied` in app logs |
| Storage rules | `storage.rules` | Cloud Storage | manual `firebase deploy --only storage` | Firebase console → Storage → Rules | `storage/unauthorized` in app logs |
| Firestore indexes | `firestore.indexes.json` | Firestore | manual (currently none — see §7) | Firebase console → Firestore → Indexes | query failures in app logs |
| CI | `.github/workflows/ci.yml` | GitHub Actions | every PR and push to `main` | PR checks / Actions tab | same |

**Access needed (roles, not credentials):**

- GitHub repository maintainer — merge PRs, revert commits.
- Vercel project member with deployment access — environment variables,
  rollbacks, deployment promotion.
- Firebase/Google Cloud project member with deploy permissions on
  `saba-sfpca` — `firebase deploy`, plus console access for logs,
  Scheduler, and rules history.

## 3. Environment variables

Canonical lists are the committed `.env.example` files — names and
purposes only, never values. Any variable not listed here and in those
files is not used by production code.

**Vercel — Production environment** (set in Vercel project settings):

| Variable | Purpose | Secret? |
|----------|---------|---------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase client init | no — public config, rules are the boundary |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase client init | no |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase client init | no |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Firebase client init | no |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase client init | no |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase client init | no |
| `FIREBASE_ADMIN_PROJECT_ID` | Admin SDK (session route, admin auth) | **yes** |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Admin SDK service account | **yes** |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Admin SDK service account | **yes** |
| `ADMIN_EMAILS` | Bootstrap/emergency admin allowlist — NOT the authorization authority (Postgres `admin_users` is; see §21) | yes-ish — emails are personal data |
| `DATABASE_URL` | Neon Postgres pooled endpoint — **required**: registry reads/writes + admin authz | **yes** (Vercel–Neon integration) |
| `DATABASE_URL_UNPOOLED` | Neon unpooled endpoint for migrations/preview self-migrate | **yes** (Vercel–Neon integration) |
| `CRON_SECRET` | Bearer guard for `/api/cron/*` routes | **yes** — random string, set in Production AND Preview |
| `RESEND_API_KEY` | Resend API key for reminder email delivery | **yes** — without it live reminder runs refuse (503); dry-run still works |
| `EMAIL_FROM` | Verified sender identity, e.g. `SFPCA <reminders@…>` — domain must be verified in Resend | no |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` webhook signing secret | **yes** — without it the webhook route refuses everything (503) |
| `NEXT_PUBLIC_GTM_ID` | Google Tag Manager container; injected only after analytics consent (§16); absent ⇒ no Google traffic | no |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for sitemap/OG/canonical | no |
| `SITE_MAINTENANCE_MODE` | `"true"` gates all public routes (§9) | no, but server-only — never `NEXT_PUBLIC_*` |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry runtime DSN — enables error capture; SDK never initializes without it | no — public config by design, not an auth secret |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | Optional Sentry environment override (defaults `VERCEL_ENV` → `NODE_ENV`) | no |
| `SENTRY_ORG` | Sentry org slug for source-map upload at build time | no, but not public config |
| `SENTRY_PROJECT` | Sentry project slug for source-map upload | no, but not public config |
| `SENTRY_AUTH_TOKEN` | Auth token for source-map upload during build | **yes** — build-time only |
| `SENTRY_RELEASE` | Optional release override (defaults to commit SHA via the build plugin) | no |

**Firebase Functions runtime** — `functions/.env`, uploaded by
`firebase deploy` (dotenv support; the file is gitignored and the
`deploy:functions` script refuses to deploy without it):

| Variable | Purpose | Secret? |
|----------|---------|---------|
| `VERCEL_TOKEN` | Deploy-hook auth — embedded in the hook URL | **yes** |
| `VERCEL_PROJECT_ID` | Deploy-hook target (`prj_…`) | sensitive — part of the hook URL |
| `REBUILD_TRIGGER_TOKEN` | Bearer secret for `triggerRebuild` | **yes** |

If the hook URL ever leaks, rotate `VERCEL_TOKEN` — the URL contains it.

**Local development** — `.env.local` (gitignored): the same root
variables. `npm run seed` additionally needs `FIREBASE_ADMIN_*`.

**Harness-only — never set these in real deployments:**

- `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` — set only by the Playwright
  `webServer` config; connects the client SDK to emulators.
- `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` — set by
  `firebase emulators:exec`; make the Admin SDK skip `cert()`.

**CI only** — `.github/workflows/ci.yml` injects `ci-placeholder`
`NEXT_PUBLIC_FIREBASE_*` values for the build; no real credentials are
used anywhere in CI.

## 4. Firebase project safety

`.firebaserc` maps the `default` alias to **`saba-sfpca`** — the
production project. Every `firebase deploy` in this repo targets it
unless you override. Confirm the target *before* any production deploy:

```bash
firebase use            # must show saba-sfpca as the active project
firebase projects:list  # confirm saba-sfpca exists and you have access
```

If the active project is wrong: `firebase use saba-sfpca` (or
`firebase use --add` to set up the alias). Deploys authenticate via
`firebase login` (browser) — no service-account key is needed for CLI
deploys.

Emulators can never hit production: `test:rules` and `test:e2e` pin
`--project demo-sfpca`, and `demo-*` projects are emulator-only by
design. No test command in this repo targets a real project.

## 5. Pre-release checklist

Before merging a PR that will go to production:

1. Branch is based on current `main` (`git fetch origin && git merge-base HEAD origin/main` — or let GitHub's "branch is up to date" tell you).
2. All four required checks are green: **Next.js app**, **Firebase
   Functions**, **Firebase security rules**, **E2E smoke**.
3. Review threads resolved; no unaddressed automated findings.
4. **Deployment surface identified** — for each changed file, does it
   reach production via Vercel (`src/`), `firebase deploy`
   (`functions/`, `*.rules`, `firestore.indexes.json`), or both?
   Functions/rules changes do *not* ship by merging — plan their deploy.
5. Rules changes: emulator suite covers the new behavior; the diff was
   reviewed as an authorization boundary, not just code.
6. New/changed env vars are listed in `.env.example` /
   `functions/.env.example` and already exist in Vercel / `functions/.env`
   *before* the code that needs them deploys.
7. Any manual console configuration is written down in the PR body.
8. Maintenance mode considered: does this release need the public gate
   up (§9)? Usually no — the flag exists for risky or half-migrated work.

## 6. Normal release — Next.js / Vercel

Merging to `main` triggers a production deployment through the Vercel
Git integration. **[console]** Confirm the project is wired the
expected way once: Vercel → Settings → Git → Production Branch = `main`.

Sequence:

1. Merge the PR. CI runs again on the `main` push (same four jobs).
2. Vercel starts a build — watch Vercel → Deployments.
3. On success the deployment is promoted to the production domain
   automatically. No manual aliasing step exists in this setup.
4. Run the post-release smoke checks (§10).
5. If the build fails, the previous production deployment stays live —
   fix forward on `main` or revert (§11).

Nothing else deploys. If the change touched `functions/`, `*.rules`, or
`firestore.indexes.json`, those deploys are your job now — see
Functions (§7) and rules (§8).

## 7. Firebase Functions

All commands run from the **repo root** (`firebase.json` points at
`functions/`). Deploys require the Firebase CLI (`firebase-tools` is a
devDependency; `npx firebase …` works without a global install) and a
login with deploy rights on `saba-sfpca`.

**Preflight:**

```bash
firebase use                    # must show saba-sfpca
cd functions && npm ci
npm run lint                    # ESLint, google style
npm test                        # functions unit tests
cd ..
```

**Deploy everything (both functions):**

```bash
firebase deploy --only functions
```

or `npm run deploy:functions`, which additionally fails fast if
`functions/.env` is missing `VERCEL_TOKEN`/`VERCEL_PROJECT_ID`.

**Deploy one function** (verified firebase-tools syntax — useful for a
hotfix that touches a single function):

```bash
firebase deploy --only functions:triggerRebuild
firebase deploy --only functions:onFirestoreChange
```

**Verify:**

```bash
firebase functions:log                          # recent executions
firebase functions:log --only onFirestoreChange # one function
```

Firebase console → Functions shows deployed revisions, trigger type,
and error rate. The old `sweepOrphanedReceipts` Cloud Function/Scheduler
job was removed in #183 — if a stale deployment still exists in the
console, delete the function and its Cloud Scheduler job **[console]**;
the replacement is the Vercel cron route (§2).

`functions/.env` is uploaded as the functions' environment during
deploy. If you deploy a function that needs `VERCEL_TOKEN`,
`VERCEL_PROJECT_ID`, or `REBUILD_TRIGGER_TOKEN` without it, the deploy
succeeds but the function logs `outcome:"skipped"` / refuses requests —
check `functions/.env` first when a deployed function silently does
nothing.

## 8. Firestore & Storage rules

Rules are an **authorization boundary**, not config — treat every rules
deploy as security-sensitive.

**Preflight (always):**

```bash
firebase use          # saba-sfpca
npm run test:rules    # full emulator suite must pass first
```

**Deploy:**

```bash
firebase deploy --only firestore:rules   # Firestore rules only
firebase deploy --only storage           # Storage rules only
firebase deploy --only firestore:rules,storage   # both, one command
```

**Verify afterward:** Firebase console → Firestore → Rules and
Storage → Rules show the new version and publish timestamp. A smoke
check that exercises the changed path (e.g., load the public adoptions
listing after a rules change) confirms the app still reads.

`storage.rules` protects private registration receipts — a bad Storage
rules deploy can expose `receipts/` or lock admins out of them. If in
doubt, roll back per §13.

**Indexes:** `firestore.indexes.json` is intentionally empty
(`{"indexes": [], "fieldOverrides": []}`) — there are no managed
indexes; current queries need none. If an index is ever added:
`firebase deploy --only firestore` deploys rules *and* indexes, or
`firebase deploy --only firestore:indexes` for indexes alone. Caution:
deploying the file can delete indexes that exist in the console but not
in the file — the CLI warns before removing them; do not answer yes
without checking what the index serves.

## 9. Maintenance mode

`SITE_MAINTENANCE_MODE` (Vercel env, Production only — never
`NEXT_PUBLIC_*`) redirects every public route to `/under-construction`
while it is `"true"`. Verified behavior (`src/lib/maintenance.ts`,
`src/proxy.ts`):

- **Stays reachable:** `/login`, `/admin/*` (still behind the session
  gate — maintenance mode never weakens admin auth), `/api/auth/*`,
  `/under-construction`, `/robots.txt`, `/sitemap.xml`, share images,
  `/_next/*` and other static assets.
- **SEO while gated:** `robots.txt` disallows everything and the sitemap
  is empty; both revert automatically when the flag lifts.
- **Scope:** this gates HTTP requests to the Next.js app only. It does
  **not** change Firestore/Storage rules — public receipt uploads to
  `receipts/` are still accepted by the rules layer, and Firebase
  Functions keep running normally.

**Enable before risky work:**

1. [console] Vercel → Settings → Environment Variables → set
   `SITE_MAINTENANCE_MODE=true`, scope **Production**.
2. Trigger a redeploy — env changes do not affect the running
   deployment; only new builds see them (Vercel → Deployments →
   redeploy latest, or push a trivial commit).

**Disable:** remove the variable (or set `false`) and redeploy again.
Verify `/` loads publicly afterward.

## 10. Post-release smoke checks

Non-mutating only — never submit test registrations or create throwaway
data in production.

1. `/` loads; hero, sections, animals render.
2. `/animal-adoptions` lists animals; `/faq`, `/contact`,
   `/animal-registration` (form renders — do not submit),
   `/vet-services` all load.
3. `/login` renders; an authorized maintainer signs in and `/admin`
   loads with real data (registrations list, animal list).
4. Maintenance mode is in its intended state (§9).
5. Vercel → Logs (Runtime): no error burst since the deploy.
6. Firebase console → Functions / Cloud Logging: no unexpected failures
   on `onFirestoreChange` since the deploy; Vercel → Logs: no
   `receipt-cleanup` errors on the cron route.
6a. Once Sentry is configured (§15): Sentry → Issues filtered to the new
   release — no new unhandled exceptions attributable to the deploy.
7. If the release changed content plumbing: make one real admin content
   edit and confirm a new Vercel deployment appears within a minute or
   two (that is the end-to-end rebuild path working).

## 11. Rollback

### 11a. Vercel (app rollback — fastest recovery)

[console] Vercel → Deployments → find the last known-good production
deployment → use the dashboard's rollback/promote control ("Instant
Rollback" / redeploy that deployment) to point the production domain at
it. Verify the domain afterward.

- Check env compatibility before rolling back far: if the bad release
   added a required env var and you already configured it, the old
   deployment simply ignores it — but if you *removed* a var the old
   build needs, restore it first.
- Rolling back the app does **not** roll back Functions, rules, or
   data — the other surfaces stay as deployed.

### 11b. Git (repository truth — always required after a bad merge)

A Vercel rollback restores service but leaves `main` broken. To make
the repo authoritative again, **revert — never force-push or rewrite
`main`**:

```bash
git revert -m 1 <merge-commit-sha>   # for a merge commit
# or: git revert <sha>               # for a regular commit
```

Push the revert, let CI go green, merge → Vercel deploys the corrected
`main`. Alternatively GitHub's "Revert" button on the merged PR creates
the revert as a new PR, which is the safer path when unsure.

### 11c. Firebase Functions

There is no `firebase rollback` command for functions, and functions do
not follow Vercel rollbacks. The supported recovery is
repository-driven:

1. Identify the last known-good function code in Git history.
2. `git revert` the offending change on a branch (or check out the
   good version of `functions/` onto a hotfix branch).
3. `cd functions && npm run lint && npm test`.
4. `firebase deploy --only functions` (or `functions:<name>` if only
   one function is affected).

[console] Cloud Functions v2 run on Cloud Run, which keeps prior
revisions — an emergency traffic rollback in the Google Cloud console
(Cloud Run → service → Revisions) can restore the previous revision in
seconds without a redeploy. Use it only as a stopgap; still do the
Git revert + redeploy so the repo remains the source of truth.

### 11d. Firestore / Storage rules

Rules changes take effect immediately and can break or expose
authorization — move deliberately:

1. Get the known-good rules from Git: `git show <good-sha>:firestore.rules`.
2. Diff against current — understand what the bad deploy changed.
3. Put the known-good content back on a branch, run `npm run test:rules`
   against it (the emulator suite validates the restored rules, not
   just new ones).
4. `firebase deploy --only firestore:rules` (and/or `storage`).
5. Verify the affected access path immediately (public read, admin
   write, receipt access).

Do not blindly restore old rules if the app's data expectations moved
(e.g., a required field was added between the good and bad versions) —
restore the rules that match the *deployed app's* expectations, which
may mean a forward fix instead.

### 11e. Data recovery

**Code rollback is not data rollback.** Firestore recovery is covered in
§17 — PITR and managed backups are enabled in production, and §17
documents the audited posture and the full restore procedure. Firebase
Storage objects are a separate boundary covered by bucket soft-delete
(§17e, §18).

## 12. Multi-system release ordering

There is no universal order — reason about *compatibility windows*:
at no point should a deployed component depend on behavior of a
component that isn't deployed yet.

- **Widening rules / new collection:** deploy rules first or together
  with the app — permissive-to-what's-needed rules break nothing
  existing.
- **Tightening rules:** only deploy first if the currently-deployed app
  already conforms (e.g., the app already writes the bound
  `paymentReceipt` shape). If it doesn't, ship the conforming app first,
  then tighten — otherwise you create a window where legitimate writes
  are rejected.
- **Functions:** decoupled from app version (they react to Firestore
  events). Deploy them in either order; just don't leave a function
  expecting a document shape the rules now reject.
- **Env vars:** always configure them *before* the code that requires
  them deploys — a missing-var deploy is a self-inflicted outage.
- **Maintenance mode (§9):** for multi-step migrations where a partial
  public view would be misleading, gate the site first, do the work,
  verify, reopen.

## 13. Incident decision path

```
Public site broken
  → Vercel → Deployments (did the last build fail? is a bad deploy live?)
  → Vercel → Logs: subsystem:"content" / error digests
  → immediate restore: Vercel rollback (§11a)
  → then: git revert + merge (§11b)

Admin can't load
  → distinguish deploy / auth / session / admin-lookup per README
    troubleshooting; treat missing FIREBASE_ADMIN_* as config, not code

Function broken / not running
  → Cloud Logging (filter resource.type="cloud_function")
  → which function? onFirestoreChange | triggerRebuild
  → fix or revert functions/ → firebase deploy --only functions[:name]

Authorization regression (rules)
  → security-sensitive — §11d: restore tested known-good rules NOW

Content change didn't reach the site
  → Cloud Logging: operation:"firestore-trigger" fired? (writes to
    animalRegistrations/admins correctly trigger nothing)
  → operation:"vercel-hook" outcome? skipped = missing env;
    failed + httpStatus/errorCode = hook rejected or network
  → Vercel → Deployments: did a deploy start and fail?
  → if the pipeline is down but a rebuild is needed now: triggerRebuild

Manual rebuild
  → POST the triggerRebuild function URL (printed by `firebase deploy`
    and listed in Firebase console → Functions; v2 URLs live on
    *.run.app) with header  Authorization: Bearer <REBUILD_TRIGGER_TOKEN>
    — placeholder only; get the real URL/token from the console and
    never paste either into docs, tickets, or chats
  → 403 = wrong/missing token · 503 = hook env unconfigured ·
    500 = upstream failure, see vercel-hook error log

Orphan-receipt sweep failing
  → Vercel → Logs, subsystem:"receipt-cleanup": a 500 execution or
    outcome:"partial-failure" summary means orphans remain; the next
    daily run retries them (idempotent). Investigate the errorCode on
    per-object warn entries. Registration IDs/receipt names are
    deliberately never logged — inspect Storage directly if needed.
  → 401s mean CRON_SECRET is unset or mismatched — the route fails
    closed; check the Vercel env var for that environment.
```

## 14. Automatic content rebuilds (post-#94)

A write to a **CMS collection** — `homepage`, `siteSettings`, `faq`,
`vetServices`, `animalAdoptions`, `animalRegistration`
(`REBUILD_COLLECTIONS` in `functions/index.js`) — triggers
`onFirestoreChange`, which POSTs the configured Vercel deploy hook, and
Vercel starts a new deployment. Writes with no actual data change are
skipped. Registry writes go to Postgres, not Firestore — animal
mutations revalidate the homepage via `revalidatePath` in the server
actions instead (the listing/detail pages are `force-dynamic`), and
every other Firestore write triggers **nothing** — by design, and so
non-CMS document paths never enter the logs.

A successful Firestore write does **not** imply a successful rebuild —
the write commits before the hook runs. If the hook fails
(non-2xx/timeout/network) the function execution is marked failed and
the error is in Cloud Logging; nothing user-visible breaks except that
the site is stale. Rebuild manually (`triggerRebuild`, §13) or fix the
hook config and edit again.

## 15. Sentry error monitoring (post-#139/#140)

Sentry collects **unexpected application exceptions** — unhandled
browser errors, React error-boundary crashes, and server-side
exceptions in Server Components, route handlers, and `proxy.ts`. It is
a supplement, not a replacement: Vercel runtime logs remain the
structured operational record (`src/lib/logger.ts`), Cloud Logging
covers Functions, and GitHub Actions gates deploys.

**When to look where:**

- **Sentry → Issues** — a user-visible crash ("Something went wrong"),
  a new exception class appearing after a deploy, or correlating a
  browser failure you cannot reproduce locally. Events group by
  exception type; each carries environment, release, route, and the
  Next.js `error_digest` tag when the error came through a boundary.
- **Vercel → Logs (Runtime)** — expected/handled failures (auth
  denials, validation, upstream fetch misses), `subsystem`/`operation`
  timelines, and anything too routine to be an exception. A boundary
  crash appears in both places: the Vercel log entry and the Sentry
  event share the same digest.
- **Cloud Logging** — Firebase Functions only; Sentry does not
  instrument Functions (deliberate — #139 scopes Sentry to the Next.js
  app).

### 15a. Configuration (operator checklist)

All values live in Vercel → Settings → Environment Variables (§3).
Nothing Sentry-related is committed to the repo.

| Variable | Scope | Kind | Required? |
|----------|-------|------|-----------|
| `NEXT_PUBLIC_SENTRY_DSN` | Production + Preview | public runtime config — embedded in the client bundle by design, **not** a secret | yes — without it the SDK never initializes and nothing is sent |
| `SENTRY_ORG` | Production (+ Preview for symbolicated preview events) | build-time, not secret | needed only for source-map upload |
| `SENTRY_PROJECT` | same as `SENTRY_ORG` | build-time, not secret | needed only for source-map upload |
| `SENTRY_AUTH_TOKEN` | same as `SENTRY_ORG` | build-time **secret** (org auth token) | needed only for source-map upload |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | — | optional public override | only if the auto value is wrong — defaults to `VERCEL_ENV` then `NODE_ENV` |
| `SENTRY_RELEASE` | — | optional build-time override | only to override the auto release (see 15b) |

Recommended scoping: set the DSN for **Production and Preview** — the
environment tag (`production`/`preview` from `VERCEL_ENV`) keeps the
streams separable. If you prefer zero preview events, scope the DSN to
Production only. Source-map variables: Production is required;
adding Preview lets preview-deploy errors symbolicate too.

### 15b. Releases and source maps

`withSentryConfig` resolves the release at build time in this order:
`SENTRY_RELEASE` env → `git rev-parse HEAD` (the deployed commit).
The **same** value is then (a) used to name the release for source-map
upload and (b) injected into both the client and server bundles, so
every event automatically reports the release its maps were uploaded
under — there is nothing extra to wire. Source maps are uploaded at
build time and deleted from the public bundle afterward — they are
never publicly exposed.

Consequences:

- A Sentry issue's release = the Vercel deployment's commit SHA — the
  same SHA shown in Vercel → Deployments and in `git log`.
- Without `SENTRY_AUTH_TOKEN` (+org/project) the build still succeeds;
  the upload is skipped and stack traces stay minified until
  configured. This is the correct local/CI behavior — do not "fix" it.
- If a Sentry event ever arrives with no release or with maps missing,
  check the Vercel build log for the upload step rather than guessing
  (see 15d).

### 15c. Post-configuration verification

After Chad sets the Sentry/Vercel values and a deployment has gone out:

1. Sign in as an admin and open **`/admin/sentry-check`** (deliberately
   not in the admin nav — URL only).
2. Click **"Throw server test error"** — the panel reports the throw.
3. Click **"Throw browser test error"** — the page is replaced by the
   real "Something went wrong" fallback with a Reference digest; note
   the digest, then click Try again.
4. In Sentry → Issues, confirm **exactly two** events with messages
   starting `SENTRY_VERIFICATION_EVENT:` (`:server` and `:browser`).
   One event per click — no duplicates.
5. Confirm each event's **environment** is `production`. A preview
   deploy performing the same steps should show `preview`.
6. Confirm each event's **release** equals the deployment's commit SHA
   (Vercel → Deployments → commit).
7. Open an event's stack trace — frames resolve to real source
   locations (e.g. `sentry-check-panel.tsx`, `actions.ts`), not
   minified `_next/static/chunks/...` references.
8. Inspect the event payload: **no** user identity, email, cookies,
   `Authorization`, request body, receipt path, or registration data —
   only method + path under request, redacted messages, safe tags.
9. For the browser event, search Vercel → Logs (Runtime) for the
   Reference digest shown on the fallback page — the
   `subsystem:"ui"` log entry with the same digest should exist.

### 15d. Troubleshooting

- **No event received** → `NEXT_PUBLIC_SENTRY_DSN` set in the right
  Vercel scope and deployed *after* it was set (env changes need a
  redeploy)? Sentry project exists and DSN copied exactly? Ad-blocker/
  CSP blocking `*.ingest.sentry.io` in the browser? Check the Vercel
  runtime log — the error still logs there even when Sentry is absent.
- **Event in the wrong environment** → `NEXT_PUBLIC_SENTRY_ENVIRONMENT`
  set unnecessarily (remove it; `VERCEL_ENV` is correct automatically),
  or the DSN is scoped to the wrong Vercel environment.
- **Event received but stack trace not symbolicated** → the release on
  the event has no uploaded artifacts: check the deploy's build log for
  the source-map upload step; confirm `SENTRY_ORG`/`SENTRY_PROJECT`/
  `SENTRY_AUTH_TOKEN` are set in the build environment and the token is
  a valid **org** auth token; confirm the event's release SHA matches a
  release in Sentry → Releases with artifacts.
- **Source-map upload failure in build log** → token expired/wrong
  scope, or org/project slug mismatch. Fix the env values and redeploy;
  the app itself is unaffected either way.
- **Duplicate events for one failure** → report it — each capture path
  is designed to fire once (single `captureException` in the shared
  fallback, framework hooks elsewhere); duplicates indicate a
  regression, not configuration.
- **Sentry event exists but no matching Vercel log** → boundary events
  correlate by the `error_digest` tag / Reference digest; server
  exceptions logged via `logger.ts` carry `subsystem`/`operation`. If
  neither is findable, the error was likely a client-only failure that
  never reached the server — expected for browser render errors.
- **Verification button says "Not authorized"** → session cookie
  expired or the account isn't in `admins/`/`ADMIN_EMAILS` — sign in
  again via `/login`.

### 15e. Alert policy (configure in Sentry manually)

Goal: page a human on **new or regressed unexpected production
application errors** — never on every occurrence.

- Scope alerts to the **production** environment only; preview events
  are noise unless deliberately wanted.
- Alert on **new issues** (first event of a new exception signature)
  and **regressions** (a resolved issue reoccurring).
- If using frequency conditions, alert only on unusual spikes —
  sustained rate increases, not single events.
- Do **not** alert on expected/rejected paths: auth denials, expired
  tokens, and validation failures are dropped by `beforeSend` and never
  reach Sentry — anything arriving is already filtered to unexpected
  errors.
- Exclude `SENTRY_VERIFICATION_EVENT` issues from paging if the alert
  rule allows message filtering (they are deliberate).
- Keep notification channels minimal (existing email/Slack); no new
  integrations are introduced by this repo.

### 15f. Privacy boundary (unchanged from #139)

Every event passes `src/lib/sentry.ts` before leaving the process:
request headers/cookies/bodies/query strings are removed, user
identity and server hostname are never attached, console and
DOM-interaction breadcrumbs are dropped, stack-frame locals are
stripped, and emails/bearer tokens/`receipts/` paths are redacted from
message text. The verification errors are synthetic — they carry no
real data and flow through the same boundary. **Customer PII must
never appear in a Sentry event.** If you ever see owner data, tokens,
or receipt identifiers in Sentry: treat it as an incident — delete the
event in Sentry, open a fix that extends the sanitizer to cover that
carrier, and check whether the same data reached Vercel logs.

**Local development and CI** send nothing: no DSN is configured, so
the SDK never initializes and no network calls are made.

## 16. Consent & analytics (post-#116)

Klaro (`klaro@0.7.21`, OSS) is the consent layer; Google Tag Manager is
the only tag-loading mechanism. The app never loads Google resources
before affirmative analytics consent.

**Architecture** — `src/lib/consent.ts` is the single consent boundary:

- `src/app/layout.tsx` pushes Google Consent Mode v2 defaults (all
  denied) into `dataLayer` before any script can run.
- `src/components/consent/consent-manager.tsx` mounts Klaro once;
  `klaro@0.7.21` is dynamically imported in a client effect (UMD bundle —
  never imported during SSR).
- The Klaro service callback pushes `consent update` entries and injects
  `gtm.js?id=$NEXT_PUBLIC_GTM_ID` exactly once (script id
  `sfpca-gtm-script`, DOM-checked). Declining later pushes a denied
  update; an already-loaded container cannot be unloaded, but Consent
  Mode stops further collection.

**Consent categories** — `necessary` (always on; auth/session cookies)
and `analytics` (optional; the `google-tag-manager` service). No
marketing/advertising purpose exists — no such tag is in use. Sentry is
operational error monitoring (§15), is not a Klaro service, and is not
gated by analytics consent.

**Consent Mode mapping** — `analytics` granted ⇒
`analytics_storage=granted`; denied ⇒ `denied`. `ad_storage`,
`ad_user_data`, `ad_personalization` are always `denied` — the site has
no ad features. Keep it that way unless a real ad tag is added.

**Storage** — `localStorage` key `sfpca-consent` (no expiry — persists
until the visitor clears it or changes choice). Bump `version` in
`buildKlaroConfig()` to re-prompt after consent-semantics changes.

**Persistent control** — footer "Cookie settings" button reopens the
Klaro modal (`window.klaro.show(config, true)`); privacy policy at
`/privacy`.

**Operator steps (production)** — Chad must do these manually; nothing
here is automated:

1. Create the GTM container; configure the GA4 tag inside it. In GTM,
   require the `analytics_storage` consent signal for the tag (or rely
   on the app's injection gating — both are in place).
2. Set `NEXT_PUBLIC_GTM_ID` (Vercel, Production; Preview optional —
   same consent flow applies).
3. Redeploy. Verify: first visit shows the notice and zero requests to
   `googletagmanager.com` in DevTools; "Accept all" loads `gtm.js` once;
   "I decline" loads nothing; "Cookie settings" in the footer reopens
   the modal.

**Adding future tags** — create them inside the GTM container and give
them the matching consent requirement; if a tag isn't analytics, add a
new Klaro service + purpose in `buildKlaroConfig()` (bump `version`) and
extend `GoogleConsentState` mapping. Never add `<script>` tags or a
direct `gtag` loader to the app — that bypasses the consent boundary.

**Local testing** — set `NEXT_PUBLIC_GTM_ID=GTM-XXXXXXX` in `.env.local`
to exercise the accept path (any value works; block/inspect requests in
DevTools). E2E uses `GTM-E2ETEST` with all Google traffic intercepted.

## 17. Firestore backup & recovery (post-#135)

Firestore resilience uses **Google-managed features only** — PITR plus
scheduled backups. There is deliberately no application-level backup
code: no export cron, no JSON dumps in Git, no second database
maintained by the app. A homemade copy job is a second system to break
and a second copy of PII to secure; the managed features are strictly
better here.

### 17a. Audited state

Verified 2026-09-22 with `gcloud` (account `chadnuttall1@gmail.com`,
explicit `--project=saba-sfpca`) against the production `(default)`
Firestore Native database in `nam5`:

| Setting | State |
|---|---|
| Point-in-time recovery | **DISABLED** |
| Scheduled backups | **none** (0 schedules, 0 backups) |
| Database delete protection | **DISABLED** |

**Current state — protection is now enabled.** The §17b steps were
completed and verified in production: PITR on (7-day window,
`retentionPeriod: 604800s`), a weekly Sunday managed backup schedule
(`retention: 4838400s` = 8 weeks), and database delete protection on.

### 17b. Enable protection — manual operator step (Chad) — **COMPLETED**

These are one-time `gcloud` commands run by the project owner. **Before
any modifying command, verify the target:**

```bash
gcloud auth list                      # confirm the intended account
gcloud projects describe saba-sfpca   # confirm the project exists/matches
gcloud firestore databases describe --database='(default)' \
  --project=saba-sfpca --format='value(name)'
# expected: projects/saba-sfpca/databases/(default)
```

Then:

```bash
# 1. Point-in-time recovery — keeps 7 days of document versions,
#    minute granularity. Reversible (--no-enable-pitr), near-zero cost
#    at this dataset size.
gcloud firestore databases update --enable-pitr \
  --database='(default)' --project=saba-sfpca

# 2. Weekly managed backup. Retention is an org policy choice — 8 weeks
#    is a reasonable default; the platform maximum is 14 weeks.
gcloud firestore backups schedules create \
  --database='(default)' --project=saba-sfpca \
  --recurrence=weekly --day-of-week=SUN --retention=8w

# 3. (Recommended, optional) block accidental database deletion.
gcloud firestore databases update --delete-protection \
  --database='(default)' --project=saba-sfpca
```

Verify afterward (all read-only):

```bash
gcloud firestore databases describe --database='(default)' \
  --project=saba-sfpca \
  --format='yaml(pointInTimeRecoveryEnablement,deleteProtectionState,earliestVersionTime)'
# expect: POINT_IN_TIME_RECOVERY_ENABLED (+ DELETE_PROTECTION_ENABLED if step 3 done)

gcloud firestore backups schedules list \
  --database='(default)' --project=saba-sfpca
# expect: one weekly schedule, retention 8w
```

Note: PITR only retains versions **from enablement forward** — the
7-day window fills gradually (`earliestVersionTime` shows the floor).
A deletion in the first minutes after enabling may still be
unrecoverable.

### 17c. Recovery model — what each mechanism covers

**PITR (once enabled):** read or clone the database as of any minute in
the last 7 days. Covers recent accidents — an admin deleting the wrong
registration, a bad deploy writing corrupt documents, a botched bulk
edit — as long as it's caught within a week. RPO in practice is ~1
minute. PITR data is read via a `snapshot-time` clone/read, so recovery
can be **surgical** (recover just `animalRegistrations/<id>`) rather
than all-or-nothing.

**Scheduled backups:** whole-database snapshots kept for the configured
retention (up to 14 weeks). Covers incidents discovered *after* the
7-day PITR window, and provides a stable long-horizon fallback. Restores
always create a **new database** — see §17d.

**Neither covers:**
- **Firebase Storage objects** — `receipts/` (payment receipts, PII)
  and `team-photos/` are not in Firestore. PITR/backup restores do not
  bring them back. See §17e.
- **Incidents older than the PITR window / backup retention** —
  retention is finite by design.
- **Deletion of the project itself**, or an attacker/operator who
  deletes both data and backups — backups live in the same project.
- **Deployed app logic bugs** — restoring data does not fix the code
  that corrupted it; contain the cause first (§17d step 1).

### 17d. Restore procedure

> **These steps can overwrite or delete production data.** Verify the
> project (`--project=saba-sfpca`, `gcloud projects describe saba-sfpca`)
> before every command. Nothing below is a routine copy/paste
> operation — read each step before running it.

1. **Contain.** Stop the thing causing corruption: roll back the bad
   deploy (§11a/§11b), or enable maintenance mode (`SITE_MAINTENANCE_MODE`,
   §9) so users don't keep writing while you recover. For a one-off
   admin mistake, just stop making changes.
2. **Identify the incident window.** Establish the last-known-good
   timestamp (UTC, minute precision). Check Cloud Logging and admin
   activity around the event.
3. **Choose the source.** Within 7 days of the incident → PITR (finest
   granularity). Older → the newest backup predating the incident:
   `gcloud firestore backups list --project=saba-sfpca`.
4. **Preserve current state.** Before any restore, note what exists
   now — writes since the incident may be valid data you'll want to
   re-apply. For surgical recovery, record the affected document IDs.
5. **Recover into a NEW database — never in place.** Both mechanisms
   create a separate database; verify data there *before* touching
   production:

   ```bash
   # PITR: clone (default) as of the last-good minute into a new DB.
   # snapshot-time must be a whole minute, within the PITR window,
   # at/after earliestVersionTime.
   gcloud firestore databases clone \
     --source-database='projects/saba-sfpca/databases/(default)' \
     --destination-database='recovery-YYYYMMDD' \
     --snapshot-time='YYYY-MM-DDTHH:MM:00Z' \
     --project=saba-sfpca

   # OR from a managed backup (new DB, same location):
   gcloud firestore databases restore \
     --source-backup='projects/saba-sfpca/locations/nam5/backups/BACKUP_ID' \
     --destination-database='recovery-YYYYMMDD' \
     --project=saba-sfpca
   ```

6. **Validate in the recovery database** (Firebase console → Firestore →
   pick `recovery-YYYYMMDD`): confirm the affected collections exist and
   spot-check known-good documents. **Do not paste recovered values
   into tickets, chats, or logs** — `animalRegistrations` contains owner
   PII.
7. **Get the data back into production.** For this dataset the
   practical path is surgical: copy the affected documents from the
   recovery DB into `(default)` via the console, or `gcloud firestore
   export`/`import` filtered by collection into a GCS bucket. A
   whole-database cutover (pointing the app at the recovery DB) is
   possible but means re-pointing config and re-establishing PITR on the
   new DB — prefer surgical recovery for this application's size.
   **Restoring over `(default)` itself is destructive — do not do it
   without first preserving current state and confirming the project.**
8. **Resume normal operation** — disable maintenance mode / redeploy the
   fixed build.
9. **Verify security rules** — Firestore rules are **per-database**:
   `firebase deploy --only firestore:rules` targets `(default)` only
   (`firebase.json` → `firestore.database`). A `recovery-*` database has
   no rules — default-deny for client SDK access, which is fine for
   console/`gcloud` reads during recovery. Deploy rules to the recovery
   DB only if you ever point the app at it. Separately, confirm
   production access paths still work on `(default)` after recovery.
10. **Clean up and record** — delete the recovery database when done
    (`gcloud firestore databases delete --database='recovery-YYYYMMDD'
    --project=saba-sfpca` — verify the name twice; this deletes data),
    and write up the incident: window, cause, what was recovered, follow-ups.

### 17e. Firestore vs Storage — the boundary

PITR and backups protect **Firestore documents only**:

| Data | Covered by PITR/backups |
|---|---|
| `homepage/main`, `siteSettings/global`, `animalAdoptions/main`, `animalRegistration/main`, `vetServices/main`, `faq/*` — site content | yes |
| `animals`, `animalRegistrations`, `admins` — **retired** pre-launch leftovers (authoritative data is Postgres — §19) | yes (inert) |
| `receipts/*` in Storage — payment receipt images/PDFs | **no** |
| `team-photos/*` in Storage — public images | **no** |

A restored `registration_submissions` row may reference a `receipts/`
object that no longer exists (and vice versa — the cron sweeper deletes
Storage objects whose submission row is gone, so an old Postgres
snapshot's submissions can point at swept receipts). Storage recovery
is covered by the bucket's native soft-delete — see §18 (audited state,
window, restore procedure, and the sweeper ordering warning).

### 17f. Security & privacy

- Backups and PITR clones contain `animalRegistrations` PII (owner
  names, phones, emails, addresses, payment-receipt references).
  Restrict restore/backup operations to the project owner and
  authorized operators; never copy production data into CI, tests,
  Git, screenshots, or logs.
- Procedure testing uses **synthetic data only** — never production
  records as fixtures.

### 17g. Testing status — honest note

The inspection commands in §17a were run read-only against production
and confirmed the audited state. The managed clone/restore paths were
**not executed** — exercising them creates real databases in the
production project, which is an operator action. The emulator does not
support PITR or managed backups, so there is no local equivalent.
Until a first restore is rehearsed, treat §17d as untested beyond
command-surface verification (`gcloud firestore databases clone`,
`restore`, `backups schedules create` confirmed present in SDK
548.0.0). Manual verification checklist after enabling: run the §17b
verify block, confirm `earliestVersionTime` advances, and confirm a
backup object appears under `gcloud firestore backups list` after the
first scheduled run.

## 18. Firebase Storage backup & recovery (post-#149)

Storage resilience uses the bucket's **native soft-delete** feature —
no versioning, no second bucket, no copy jobs. This section covers the
two prefixes the app actually uses: `receipts/` (private registration
payment receipts — PII) and `team-photos/` (public site images). The
two `gcf-v2-*` buckets in the project are Cloud Functions platform
plumbing, not application data — ignore them for recovery purposes.

### 18a. Audited state

Verified 2026-09-22 with `gcloud storage` (account
`chadnuttall1@gmail.com`, `--project=saba-sfpca`), metadata only — no
object contents were listed, downloaded, or displayed:

```
gcloud storage buckets list --project=saba-sfpca
gcloud storage buckets describe gs://saba-sfpca.firebasestorage.app
```

| Setting | State |
|---|---|
| App bucket | `saba-sfpca.firebasestorage.app` |
| Location / class | `US-CENTRAL1` (region) / REGIONAL |
| **Soft delete** | **ENABLED — 56-day retention** (`retentionDurationSeconds: 4838400`, extended from the 7-day platform default per §18b) |
| Object Versioning | disabled |
| Lifecycle rules | none |
| Retention policy / bucket lock | none |
| Public access prevention | inherited (project); receipts stay private via Storage rules |
| Uniform bucket-level access | off (fine-grained — normal for Firebase) |
| Bucket ACL | project team only — no public/allUsers entries |

### 18b. Production change — manual operator step (Chad) — **COMPLETED**

The retention extension below has been run and verified in production
(`retentionDurationSeconds: 4838400`). The commands remain here as the
reference for any future window change. Soft delete was already on; the
change **extended the retention window to 56 days** so it matches the
8-week Firestore backup horizon (§17b). A Firestore backup restore can resurrect a
registration whose receipt was deleted weeks ago — a 7-day Storage
window would leave that receipt unrecoverable while the document is
not. Storage cost for the extra window is negligible at this dataset
size, and 56 days is still bounded — deleted PII is not kept forever.

Run in **PowerShell** (single-line commands — verify the target first):

```powershell
gcloud auth list
gcloud projects describe saba-sfpca
gcloud storage buckets describe gs://saba-sfpca.firebasestorage.app
# confirm: this is the app bucket, soft_delete_policy present

gcloud storage buckets update gs://saba-sfpca.firebasestorage.app --soft-delete-duration=56d

# verify afterward (read-only):
gcloud storage buckets describe gs://saba-sfpca.firebasestorage.app
# expect: soft_delete_policy.retentionDurationSeconds = '4838400'
```

**Deliberately not enabled:** Object Versioning. Soft delete already
preserves the prior object state on overwrite or delete, so versioning
would stack a second mechanism that adds lifecycle complexity without
covering a scenario soft delete misses at this scale.

### 18c. What soft delete covers — and what it does not

**Covered (within the retention window):**
- Accidental object deletion (admin delete, client cleanup, sweeper)
- Accidental overwrite — the pre-overwrite state is restorable
- A bad app deploy or function bug that deletes objects
- `sweepOrphanedReceipts` false-positive deletions (see §18e)

**Not covered:**
- Anything older than the retention window (soft-deleted objects are
  permanently deleted when it expires — this is the desired behavior
  for PII, not a gap to close)
- **Early permanent deletion**: an operator/attacker with
  `storage.objects.delete` can purge a soft-deleted object before the
  window ends — credential compromise is not solved by retention
- **Bucket or project deletion** — soft delete protects objects, not
  the bucket or project container
- **Region loss** — the bucket is single-region (`US-CENTRAL1`);
  multi-region replication is disproportionate for this app
- Data that was never uploaded

### 18d. Restore procedure

> Receipt object names are registration submission IDs — treat them as
> sensitive. Query a specific object path; do **not** dump whole-prefix
> listings into terminals, tickets, or logs. Never download a receipt
> just to check it exists — validate via metadata.

1. **Identify the object.** From the Postgres `registration_submissions`
   row, `payment_receipt_path` holds `receipts/<submission uuid>`.
   For team photos, the member record stores the `team-photos/...`
   URL.
2. **Confirm it is soft-deleted** (metadata only):

   ```powershell
   gcloud storage ls gs://saba-sfpca.firebasestorage.app/receipts/<REGISTRATION_DOC_ID> --soft-deleted
   ```

   No output = the object is outside the recovery window (or never
   existed) — see step 5.
3. **Restore it** (mutating — verify project first with
   `gcloud config get-value project` or an explicit
   `gcloud projects describe saba-sfpca`):

   ```powershell
   gcloud storage restore gs://saba-sfpca.firebasestorage.app/receipts/<REGISTRATION_DOC_ID>
   ```

   For a bulk incident (many objects deleted in a window), restore by
   time bounds — still scoped to the prefix, never a blind bucket-wide
   restore:

   ```powershell
   gcloud storage restore gs://saba-sfpca.firebasestorage.app/receipts/ --deleted-after-time=<ISO8601> --deleted-before-time=<ISO8601>
   ```
4. **Validate without exposing contents.** Check metadata only
   (`gcloud storage objects describe gs://.../receipts/<id>` — size,
   md5Hash, updated). Functional check: open the registration in the
   admin UI — the receipt link should resolve again.
5. **Outside the window / never uploaded:** the object is gone.
   Operationally, re-collect the receipt from the registrant; there is
   no deeper copy to reach for.

### 18e. Orphan-sweeper interaction (`/api/cron/sweep-receipts`)

The sweeper (Vercel cron, daily) deletes `receipts/<uuid>` objects whose
Postgres `registration_submissions` row does not exist and which are
older than one hour. Two properties matter for recovery:

- **Soft-deleted receipts are invisible to the sweeper** — its listing
  sees live objects only. A swept receipt stays recoverable for the
  whole soft-delete window.
- **Postgres restore ordering hazard:** while a Neon branch restore or
  migration replay is in progress, a receipt can look orphaned if its
  submission row is temporarily missing. As cheap insurance during any
  §19/§20 restore or re-import that leaves submissions temporarily
  absent: **pause the cron first** (Vercel → Settings → Cron Jobs →
  disable, or temporarily remove the `vercel.json` entry and redeploy),
  and resume it after the data is verified complete.

**Combined incident ordering** (submission row + receipt both gone):

1. Pause the sweeper cron (above).
2. Recover the Postgres row first (§19/§20 — Neon instant restore or
   snapshot) — `payment_receipt_path` tells you the exact object name.
3. Restore the Storage object per §18d, then resume the sweeper.
4. Validate the pair in the admin UI before reopening the site.

If the row is restored but its receipt is beyond the soft-delete
window, the submission remains valid — only the attachment is
unrecoverable (re-collect from the registrant).

### 18f. Privacy & retention boundary

- Soft-deleted `receipts/` objects are PII held for the recovery
  window only — this is **recovery retention, not business retention**.
  When #130 defines a registration retention policy, deliberate
  deletions still age out of soft delete on the same 56-day clock; the
  mechanism cannot turn a deletion decision into permanent storage.
  If #130 ever requires immediate PII destruction, an operator must
  explicitly purge the soft-deleted object — document that in the
  retention policy.
- Restore access inherits bucket IAM (project editors/owners) — keep it
  that way; never grant receipt reads to satisfy a recovery workflow.

### 18g. Testing status — honest note

Configuration was verified read-only against the live bucket
(`buckets describe`). The `gcloud storage restore` path was **not
executed against production** — no real receipt was deleted to prove
recovery, by design. First-restore confidence comes from the operator
checklist in §18d; if a live rehearsal is ever wanted, create a
synthetic object under a documented test name (e.g.
`team-photos/recovery-test.txt` containing no real data), delete it,
restore it, delete it again — never use a real `receipts/` object.

## 19. Neon Postgres operations (post-#165/#180)

### 19a. Audited topology (verified 2026-09 via Neon API + live deploys)

- Vercel project `sfpca` (`prj_KHekqzSJKLYErZ0RbATE8BHNpFgJ`) is linked to
  Neon project `sfpca-db` (`withered-sound-26167673`) via the native
  Vercel integration resource `store_Z35KM1ryj86s4YOG`, plan **Free**,
  connected for **Preview + Production** environments only.
  Development receives no Neon variables.
- The integration provisions 16 env vars (all Secret type). The app
  canonically uses two:
  - `DATABASE_URL` — pooled runtime endpoint (`-pooler` host, PgBouncer)
  - `DATABASE_URL_UNPOOLED` — direct endpoint for schema/data migrations
  The remaining aliases (`POSTGRES_*`, `PG*`, `NEON_PROJECT_ID`) are
  integration-managed conveniences; do not add more consumers.
- Region `aws-us-east-1`, PostgreSQL 18.6 — verified live.
- **Production** resolves to primary branch `main`
  (`br-patient-flower-aw6fjpk6`) → endpoint `ep-soft-wind-awarztez`,
  database `neondb`, role `neondb_owner`.
- **Preview isolation is real and verified**: the integration creates a
  Neon branch `preview/<git-branch>` per git branch (copy-on-write child
  of `main`), each with its own endpoint. Two consecutive preview
  deploys of `ops/180-neon-integration` both resolved to endpoint
  `ep-lucky-dawn-awycnd8u` on branch `br-ancient-block-aw2loajx`
  (`preview/ops/180-neon-integration`) — never `ep-soft-wind-awarztez`.
  Preview credentials are physically incapable of writing to
  Production's branch.
- Stale preview branches (e.g. old PRs, dependabot) can accumulate —
  Neon Free allows **10 branches per project**; delete obsolete
  `preview/*` branches from the Neon console if provisioning slows.
- See ARCHITECTURE.md §10–§13 for the variable/table reference.

### 19b. Schema migration lifecycle

**Preview — automatic.** `npm run build` runs `prebuild` →
`scripts/preview-migrate.ts`, which applies `drizzle/` migrations to the
preview branch via `DATABASE_URL_UNPOOLED`. It no-ops everywhere except
`VERCEL_ENV=preview`; in preview it fails the deployment if the target
is missing/unreachable/migration fails. Verified live: a fresh preview
build applied all 15 tables.

**Production — deliberate operator step.** Migrations never run during
production builds or from application requests. To apply a migration:

1. Vercel dashboard → project `sfpca` → Settings → Environment
   Variables → reveal `DATABASE_URL_UNPOOLED` (Production scope).
2. Paste it into local `.env.local` (gitignored — never in shell
   history, tickets, or chat).
3. Run `npm run db:migrate`. The script prints
   `host=… db=… user=…` — confirm it is the **production** branch
   endpoint before trusting the result. It exits non-zero on failure.
4. Remove the line from `.env.local` when done.

Replay is idempotent: `__drizzle_migrations` makes re-runs no-ops.

### 19c. Migration failure / bad-migration recovery

- A failed migration aborts the script non-zero; drizzle applies each
  migration file atomically and records only completed files in
  `__drizzle_migrations`. **Fix-forward is the default**: correct the
  checked-in SQL, re-run `db:migrate`.
- If a migration caused damage beyond fix-forward (destructive DDL on
  real data): use Neon **instant restore** on the affected branch
  (Neon console → branch → Restore → choose a timestamp just before the
  migration) — this creates/restores into a branch; verify, then repoint
  `DATABASE_URL*` to the restored endpoint or promote the branch.
  On the Free plan the instant-restore history window is **6 hours**
  (1 GB cap, project-level setting) — a bad migration must be caught
  quickly, or a snapshot taken beforehand (Free allows 1 manual
  snapshot; no scheduled snapshots). PITR applies to **root branches**
  — `main` qualifies; preview branches don't need it. The drill in
  §19e is the tested procedure.
- Always take a Neon snapshot before intentionally destructive
  migrations once Postgres holds real data (post-#183).

### 19d. Credential handling & rotation

- DB credentials exist only in: Vercel env vars (Secret), Neon, and
  transiently in operator `.env.local`. None are in git; CI has none.
- Rotation: Neon console → branch → Roles → reset `neondb_owner`
  password → update the Vercel env var values → redeploy Production and
  one Preview to verify. (The native integration may propagate role
  changes automatically — verify rather than assume.)
- If a value is ever exposed (log, ticket, screenshot): rotate
  immediately — the endpoint hostnames are stable, so the password is
  the secret that matters.
- **Least privilege:** the integration provisions a single
  `neondb_owner` role used for both runtime and migrations. A reduced
  runtime role (no DDL) is a legitimate hardening follow-up but is not
  required while the registry is non-authoritative — revisit at the
  #183 cutover alongside the independent-backup decision.

### 19e. Recovery drill record (executed 2026-09-22)

Verified end-to-end against a disposable branch — no Production data
touched:

1. `POST /projects/{id}/branches` → created `recovery-drill-180`
   (`br-solitary-poetry-awljh0l0`) off `main` with a read_write endpoint.
2. `GET .../roles/neondb_owner/reveal_password` → transient connection
   string (deleted after use).
3. Created `recovery_drill` table, inserted `drill-marker-180`, recorded
   `now()` → T0, waited, dropped the table.
4. `POST /branches/{id}/restore` with `source_branch_id`=self,
   `source_timestamp`=T0, `preserve_under_name=drill-pre-restore-backup`
   → HTTP 200, branch reset to T0 (old head preserved as a backup
   branch, then deleted).
5. Reconnected: marker row present — **point-in-time restore works** on
   this project. Drill branch + backup branch deleted via API.

The exact API calls above are the documented bad-migration recovery
procedure for Neon; substitute the target branch id. Note self-restore
requires `preserve_under_name` (the pre-restore state is kept as a
new child branch — clean it up after confirming recovery).

### 19f. Accepted interim posture & hard gates

**Decision (recorded 2026-09):** the Neon **Free** plan is intentionally
retained for now. Its instant-restore history window is **6 hours**
(1 GB cap), with 1 manual snapshot and 10 branches per project. This
is acceptable **only because**:

- Firestore remains authoritative — Postgres currently contains
  schema only, no imported registry data;
- the verified rollback source during #181/#182 is Firestore itself;
- no runtime path reads or writes Postgres yet.

The 6-hour window does **not** meet the ≥7-day recovery target for
eventual authoritative Postgres use (Firestore-side PITR is 7 days).
That gap stays open on #180 and must be resolved **before #183** —
see the hard gate below. Do not treat the current window as satisfying
the original #180 recovery objective.

**#181 precondition — snapshot before every production import.** A
manual Neon snapshot of `main` is a hard operator precondition before
*every* production `migrate:firestore --execute` run — not just the
first planned import:

1. Take a manual snapshot of the `main` branch (Neon console or API).
2. Verify the snapshot exists and its timestamp predates the run.
3. Run the import; reconcile source/destination counts + integrity.
4. If the import is bad, restore/revert the Postgres side while
   Firestore is still authoritative.

Free allows exactly **1 manual snapshot**: before a later controlled
run, replace/delete the previous disposable import snapshot so a fresh
one can be taken — the snapshot must always reflect the state
immediately before *that* run, not an older import.

**#183 hard gate.** #183 must not retire Firestore authority until the
Postgres recovery posture is **at least equivalent to the current
Firestore protection** (7-day PITR + weekly 8-week-retained backups +
delete protection). Acceptable resolutions include a Neon tier with
≥7-day PITR or another verified mechanism providing equivalent or
better recoverability — the exact mechanism is deliberately not
decided here. No independent backup system is built now; the
re-evaluation trigger is the #183 cutover checklist.

## 20. Firestore → Postgres import (#181)

One-time operational import of the registry collections. Postgres is a
verified shadow copy afterward — **Firestore remains authoritative**;
no runtime path changes.

### 20a. Scope

| Source (Firestore) | Destination (Postgres) | Key |
|---|---|---|
| `animals` | `animals` | `legacy_id` = doc id |
| `admins` | `admin_users` | `lower(email)` = doc id |
| `animalRegistrations` | `registration_submissions` | `legacy_id` = doc id |

CMS collections and Storage objects are never migrated. Owner contact
data is preserved as a snapshot on the submission row — Person/household
linkage is deliberately deferred to #178.

Transform rules live in `scripts/lib/migrate-transform.ts`; every
normalization produces a classified exception (kind/field/shape only —
never values). The Firestore `status` maps to `adoption_status`
(#167: it was always the public-catalog state); unrecognized values
import as private `pending` (fail-closed) and are always flagged.
Imported animals enter the registry as `lifecycle_status='active'`; the
legacy free-text `approxAge` is preserved verbatim in the staff-only
`identifying_notes` — it is never fabricated into a birth date.

### 20b. Tooling

- `npx tsx scripts/audit-firestore.ts --project=saba-sfpca` — read-only
  structural inventory (counts, field names/types, enum distributions;
  never field values).
- `npx tsx scripts/migrate-firestore.ts --project=saba-sfpca` — dry run:
  source counts + exceptions + destination connectivity check.
- `npx tsx scripts/migrate-firestore.ts --project=saba-sfpca --execute` —
  writes; additionally requires `MIGRATION_CONFIRM_PROJECT=saba-sfpca`.
- `npx tsx scripts/reconcile-migration.ts --project=saba-sfpca` —
  read-only source↔destination comparison; exit 1 on any mismatch.
- `npx tsx scripts/neon-ops.ts …` — branch/snapshot/connection-string
  management via NEON_API_KEY (project-scoped key in `.env.local`;
  revoke when the migration program completes).

### 20c. Rehearsal procedure (required before production)

1. `neon-ops create-branch migrate-rehearsal-181` (off `main`).
2. `neon-ops conn migrate-rehearsal-181` → writes
   `DATABASE_URL_UNPOOLED` into `.env.local`.
3. `npm run db:migrate` → schema onto the rehearsal branch.
4. `migrate-firestore --project=saba-sfpca --execute` +
   `MIGRATION_CONFIRM_PROJECT=saba-sfpca`.
5. `reconcile-migration --project=saba-sfpca` → must pass.
6. Re-run `--execute` → `reconcile` again → proves idempotency.
7. `neon-ops delete-branch migrate-rehearsal-181` when done
   (Free plan: 10-branch cap).

### 20d. Production execution procedure

1. Confirm Firestore is still authoritative (no code change claims
   otherwise) and source project is `saba-sfpca`.
2. `neon-ops snapshot` on `main`; `neon-ops snapshots` → verify it
   exists and predates the run. **Required before EVERY `--execute`.**
   Free allows 1 manual snapshot — delete the prior disposable one
   before a later run.
3. `neon-ops conn main --production` → verify the written host is the
   `main` endpoint (`ep-soft-wind-awarztez…`).
4. Dry-run → review counts/exceptions → `--execute` → reconcile.
5. Reconcile must pass; if it fails materially: fix-forward importer
   (fresh snapshot before re-run) or restore `main` to the snapshot —
   Firestore is untouched either way.
6. Remove `DATABASE_URL_UNPOOLED`/`MIGRATION_CONFIRM_PROJECT` from
   `.env.local` when finished.

### 20e. Drift

Postgres becomes stale the moment production Firestore changes after
the import. There is no sync system by design. **Before #182 cutover:
re-run dry-run → fresh snapshot → `--execute` → reconcile.** The
idempotent upsert makes the refresh a diff-apply, not a re-import.

### 20f. PII discipline

Tooling prints counts, doc ids, exception kinds/fields — never owner
names, emails, phones, addresses, or receipt contents. No production
exports are committed; fixtures in tests are synthetic only.

### 20g. Execution record (2026-09-23)

Rehearsal on isolated branch `migrate-rehearsal-181` (endpoint
`ep-old-queen-aw7t0dqc`, distinct from production `ep-soft-wind-awarztez`):

- `db:migrate` → schema applied (branch cloned `main`'s schema; replay no-op)
- `--execute` → animals 3, admins 4 upserted; reconcile PASSED (7 docs, 0 diffs)
- **Second `--execute` exposed an idempotency defect:** the upsert set
  `updated_at = now()` on conflict, diverging from the source `updatedAt`.
  Fixed to `excluded.updated_at` (copy source value); re-run then
  reconciled to 0 mismatches. Branch deleted after rehearsal.

Production `main` (snapshot `snap-morning-silence-aw9w4k2p`, verified
pre-run): dry-run 7 docs / 0 exceptions → `--execute` → animals 3,
admins 4 upserted → reconcile PASSED (7 docs, 0 diffs). Destination now
holds a verified shadow copy; **Firestore remains authoritative.**

## 21. Registry cutover complete (#183)

Postgres is the single operational authority for animals,
`registration_submissions`, and `admin_users`. The `PUBLIC_ANIMALS_SOURCE`
flag and all Firestore operational paths were removed — there is no
runtime switch and no Firestore fallback.

**Final authority:** public + admin animal reads/writes, registration
intake/review, and admin authorization → Postgres (`src/lib/registry/*`
via server actions). CMS → Firestore. Sessions → Firebase Auth (with an
`admin` custom claim stamped by the session route so rules keep
authorizing client-SDK CMS/Storage writes). Receipts/photos → Firebase
Storage (paths in Postgres). Firestore `animals`, `animalRegistrations`,
`admins` are deny-all for every principal — retired, not deleted.

**Schema rollout:** production `main` needs
`drizzle/0001_outgoing_lady_mastermind.sql` (`registration_submissions.
animals jsonb`) before the cutover deploy serves traffic — apply via
`npm run db:migrate` with `DATABASE_URL_UNPOOLED` (§19b). Preview
branches self-migrate during build.

**Admin provisioning:** the first post-cutover admin signs in with an
`ADMIN_EMAILS`-listed verified account; the session route provisions
their `admin_users` row automatically. Thereafter `admin_users` is the
authority — add/remove staff with SQL (`INSERT INTO admin_users (email,
role) VALUES (...)` / `DELETE`), not env changes. Removing a row takes
effect at the next session verification; their Firebase custom claim is
cleared on their next session POST.

**Operational rollback:** code rollback restores the Firestore rules +
client paths, but post-cutover writes only exist in Postgres — a
rollback needs the data direction decided explicitly (§11). The right
response to a Postgres incident is fixing Postgres, not flipping back.

## 22. Reminders & owner communications (#172)

Automated owner reminders run as one pipeline: eligibility evaluation →
idempotent queueing into `communications` → delivery drain → outcome
recording. The database is the source of truth; the Resend dashboard is
a diagnostic aid only.

### 22a. What runs when

- `/api/cron/reminders` — Vercel cron, daily 12:00 UTC (08:00 AST).
  Auth: `Authorization: Bearer $CRON_SECRET`; fails closed when unset.
- `/api/webhooks/resend` — Resend delivery events (delivered/bounced/
  failed/complained), signature-verified via `RESEND_WEBHOOK_SECRET`;
  fails closed when unset.
- `/admin/communications` — staff surface: exception list, send
  history, dry-run preview.

**Active reminder kinds:** `vaccination-reminder` (eligibility is
#173's canonical `listDueVaccinations`) and `annual-confirmation-reminder`
(eligibility is #166's `listOwnershipsRequiringConfirmation` — the
append-only `ownership_confirmations` table is the authoritative "last
confirmed" source; household-owned animals resolve to a contactable
member), and `registration-due-reminder` (eligibility is #169's
`listUnregisteredAnimals` — lifecycle 'active' animals with no active
current-period registration; cycle key is the period year; 'unknown'
lifecycle shows in the staff queue but is never emailed). The
unpaid-balance reminder remains **not** active: it needs #170's
authoritative balance state — see `src/lib/reminders/policy.ts` for the
intended cadence.

### 22b. Enabling delivery (operator checklist)

1. Verify the sender domain in Resend; create an API key.
2. Vercel → Environment Variables (Production + Preview):
   `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `SFPCA <reminders@sabafpca.com>`),
   `RESEND_WEBHOOK_SECRET` (from step 3).
3. Resend → Webhooks → add endpoint
   `https://www.sabafpca.com/api/webhooks/resend`, subscribe to
   `email.delivered`, `email.bounced`, `email.failed`,
   `email.complained`; copy the signing secret into step 2.
4. Run a dry run (below) before the first scheduled send.

Without `RESEND_API_KEY`/`EMAIL_FROM` the cron route returns 503 for
live runs — it never silently queues mail that cannot send.

### 22c. Dry run — always before bulk changes

```
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.sabafpca.com/api/cron/reminders?dry_run=1"
```

Optional `&as_of=YYYY-MM-DD` makes the run reproducible. The response
reports `evaluated`/`queued`/`skipped`/`suppressed` plus per-reason
breakdowns. Dry-run writes nothing and cannot send — the provider is
never constructed on that path. Staff can run the same evaluation from
`/admin/communications` → "Preview next reminder run".

### 22d. Communication states & exceptions

`queued → sending → sent → delivered`; `failed` and `skipped` are
terminal. `detail` carries the machine-readable reason:

- Skips (fixable data gaps or recipient choice): `no-owner`,
  `ambiguous-ownership`, `household-no-contact`, `missing-email`,
  `invalid-email`, `opted-out`.
- Failures: `provider-rejected`, `provider-unavailable` (auto-retries
  while under the attempt cap), `retry-exhausted`, `interrupted`
  (send outcome uncertain — **never auto-resent**), `bounced`,
  `complained`, `delivery-failed`, `malformed`.

**Staff workflow** (`/admin/communications`): fix the underlying record
(ownership, email, medical record) → the exception clears on the next
run, or requeue a `failed` row manually after checking Resend. For
`interrupted` rows, verify in the Resend dashboard whether the send
went out before requeueing — the provider may hold a copy.

### 22e. Idempotency & retry model

- `communications.idempotency_key` is unique —
  `<prefix>:<relatedId>:<cycleKey>:<touch>` (e.g.
  `vax-reminder:<vax>:<due-date>:reminder-1`). Repeated cron runs,
  retries, and manual re-evaluation collapse to one row.
- The row uuid is sent as Resend's `Idempotency-Key` — a same-day
  provider retry of the same row cannot double-send.
- Cooldown: 14 days between touches of one cycle; 3 touches max per
  cycle (`vaccination-reminder` policy). `annual-confirmation-reminder`
  uses a 30-day cooldown and 2 touches (`confirm-reminder:` keys).
- `unavailable` outcomes requeue automatically (bounded by 5 attempts);
  `interrupted`/`rejected` are staff-only retries via the requeue
  action (audited).

### 22f. Preferences

`communication_preferences` records per-(person, channel, kind)
opt-outs — staff-recorded today (owners manage contact details in the
portal but not per-kind opt-outs). Opt-outs suppress only kinds the
policy marks `optional` (currently `vaccination-reminder`);
operational notices — `annual-confirmation-reminder` and the deferred
registration/payment kinds — are never silenced by a preference row
(the `kind` CHECK refuses non-optional kinds outright). There is
deliberately no global unsubscribe.

### 22g. Observability

Structured logs under `subsystem:"communications"` (`reminder-cron`,
`resend-webhook`, drain operations) — counts and coarse reasons only,
never recipient addresses or bodies. Sentry captures unexpected errors
through the same logger. Delivery truth lives on the `communications`
rows; webhook misses are visible as `sent`-not-`delivered` rows.

## 23. Owner portal & registry requests (#166)

### 23a. What owners can do

`/portal` (session-gated, `noindex`) is the owner-facing surface: contact
details, household membership, currently-owned animals, annual
confirmation ("still living on Saba and associated with me"), and
change reports. "Previously with you" lists closed associations —
animals that died, left Saba, or were transferred stay visible as
history with their lifecycle label instead of silently disappearing.
Owners cannot apply ownership, identity, or lifecycle changes
themselves — reports land as `pending` `owner_requests` rows.

### 23b. Staff review workflow

`/admin/requests` is the focused queue. Kinds:

- **Account claim** — filed automatically at login when the sign-in
  email matches an unclaimed `persons` row. Approving links the
  `auth_identities` row to the staff-chosen person; rejecting leaves
  the account unlinked. Never link without verifying the claimant out
  of band — a matching email is not proof of identity.
- **No longer mine** — approving closes the reporter's ownership
  interval (effective date optional). The animal becomes ownerless and
  stays in history; assign a new owner from the animal record if known.
- **Transfer to new owner** — the owner's typed target is free text,
  never a link. Approving requires staff to pick the real person or
  household; the old interval closes and the new one opens atomically.
- **Report deceased / Moved off Saba** — approving runs the
  authoritative lifecycle transition (#167): `animals.lifecycle_status`
  becomes `deceased`/`moved-off-saba` effective the chosen date, EVERY
  open ownership interval closes (the reporter's and any co-owners' —
  the animal has no on-island owner of record), open follow-ups and
  clinic expectations cancel, and an `animal_lifecycle_events` row
  records the transition with `source='owner-request'`. All intervals
  are preserved as history; owners see the animal under "Previously
  with you". If the transition fails the request stays pending.

Owners see outcomes on their next portal visit; there is no owner
notification on resolution (a deliberate gap, not a bug).

### 23c. People & households

`/admin/persons` manages registry people, auth-identity links, and
household membership. Linking/unlinking an identity changes who can see
what — it is audited and reversible, but verify before linking an
account to a person with animals. Person records are never deleted
through the UI; historical ownership references them.

### 23d. Failure modes

- Portal shows "Account under review" = identity unlinked (claim
  pending or provisioning failed). Check `/admin/requests` first;
  `subsystem:"session"` logs record provisioning errors.
- Owner reports a missing animal: check ownership history on the animal
  record — a closed interval means a transfer/report was resolved;
  an absent row means the link never existed.

## 24. Microchip lookup & found animals (#168)

### 24a. The volunteer scan workflow

`/admin/chip-lookup` (admin-only, `noindex`) is the found-animal tool —
optimized for a volunteer standing next to a stray with a scanner.
Scanners are **keyboard-wedge devices**: they type the number and send
Enter; no drivers or special hardware are involved, and nothing in the
app is hardware-specific.

1. Open Chip Lookup (nav, or the dashboard card). The field is already
   focused — do NOT click into it first.
2. Scan (or type) the chip number and press Enter. Formatting does not
   matter: `"985 112 345 678 901"`, `"985-112-345-678-901"`, and
   `"985112345678901"` are the same chip — the canonical normalizer
   (uppercase, non-alphanumerics stripped) handles it identically to
   registry search and record creation.
3. On a match, verify identity first: name, registry ref, species/sex,
   photo/identifying notes, and the lifecycle badge. **If the badge says
   deceased or moved-off-Saba, verify carefully** — the registry may be
   stale; flag it rather than trusting it.
4. The Owner contact block is what you need to return the animal.
   Multiple current owners show an ambiguity warning — verify before
   releasing the animal. "No registered owner" is explicit, not an error.
5. Open cases on the animal show on the result card — **a "Reported
   missing" banner means the animal was already reported lost: this
   scan is the reunion signal.** Record the outcome (reunited /
   owner located / in-care / deceased / other + a short note) to open
   or resolve a `lost_found_cases` row (#176). A plain scan with no
   outcome still lands as a scan entry on the case timeline.
6. Scan the next animal — the field is cleared and focused already.

### 24b. Unknown and conflict states

- **No match** — the normalized number is shown so you can copy it. The
  obvious next steps are on the card: search the registry (the animal
  may be registered without a chip) or flag the chip for follow-up —
  which opens an unmatched `lost_found_cases` row keyed by chip (one
  open case per unknown chip; re-scans fold into it). Nothing creates
  an animal automatically on an unknown scan.
- **Conflict warning** — the chip number was claimed for a second
  animal while already assigned. The match still shows the current
  holder, plus a warning banner. Resolve it on the animal profile's
  Microchips panel (inspect both animals, correct or close the wrong
  record, then Resolve the conflict). The registry never silently
  moves a chip between animals.

### 24c. Chip record management (animal profile → Microchips panel)

- **Add chip** — only when the animal has no current chip. If the
  number already identifies another animal the write is rejected and a
  conflict is flagged for review — that is the protection working, not
  a failure.
- **Replace chip** — a new chip was implanted; closes the old record
  (`closed_reason='replaced'`, linked to the successor) and opens the
  new one atomically.
- **End use** — chip removed or the record was wrong (`corrected` —
  the chip never belonged to this animal). History is preserved either
  way; rows are never deleted.
- **Correct** — fix a typo in the number or metadata in place. This is
  NOT a replacement and manufactures no fake history.
- Old/replaced chips still match a scan — the result says "no longer
  current" and shows the successor, so a scan of stale hardware still
  finds the animal.

### 24d. Failure modes

- Lookup says "not a recognizable chip number": fewer than 4 or more
  than 32 alphanumeric characters after normalization — re-scan or
  check the paperwork.
- "The registry lookup failed" (retryable): Postgres unreachable —
  same DATABASE_URL dependency as the rest of the registry; check Neon
  status per §19.
- A scan finds the animal but no owner appears even though one is
  expected: check ownership intervals on the profile — a closed
  interval means a transfer/report already ran; add a new owner there.

## 25. Lost & found cases (#176)

The lost/found workspace (`/admin/lost-found`, nav "Lost & Found") is
where missing-animal and found-animal reports live. A CASE is a work
item about a real-world event — deliberately separate from the animal's
permanent registry status: an animal stays `active` while a missing
case is open, and closing a case never rewrites the animal record,
ownership, or registration.

### 25a. The volunteer workflow

**Report an animal missing.** From the animal's profile → Lost & found
panel → "Report missing" → last-seen details → "Open missing case". At
most one open missing case exists per animal — a duplicate click just
returns the existing case. Owners can also report their own animal
missing from `/portal` ("{name} is missing") — those arrive flagged
"reported by owner"; former owners cannot file (authorization is
current-ownership only).

**Found animal intake.** Three doors, one model:

1. **Chip scan** — `/admin/chip-lookup` (§24). A match attaches the
   scan to the animal's open case (or opens a `found` case); an
   unknown chip's "Flag for follow-up" opens an *unmatched* found case.
2. **Unmatched found case** — workspace → "Report a found animal":
   chip if scanned, found location, description, reporter. Nothing
   here creates an animal record.
3. **A missing animal turns up** — the scan lands on the open MISSING
   case as a timeline entry; no duplicate found case is created. A
   missing and a found case may coexist on one animal — resolving
   either closes both with the same outcome ("the missing animal was
   found" is one event).

**Work the case.** Case detail shows what was reported, the linked
animal + CURRENT owner contact (staff-only), and the append-only
chronology. Add sightings/updates from the form (kind, location, note,
reporter). An unmatched case links through registry search — never
fuzzy auto-matching; `linked_at`/`linked_by` preserve that it began
unmatched.

**Publish (optional).** A *missing* case can be listed on the public
`/lost-pets` page — explicitly, via "Publish to the lost-pets page"
with an approved public note. The public page shows ONLY: name, photo,
species/sex/age, missing-since date, last-seen location, and your
approved note. Owner/reporter contact, staff notes, and chip numbers
are never public. The public "I've seen this animal" button files a
sighting TO SFPCA — it does not connect the reporter to the owner.
Resolution or "Unpublish" removes the listing automatically.

**Resolve.** "Resolve…" → outcome → done. History is never deleted:
the case stays on the animal profile and under "Recently closed".
`Deceased` additionally runs the canonical lifecycle transition (with
the real-world date) — that is the ONLY outcome that changes the
registry record. "Cancel case" is for reports that were wrong
(duplicates, mistakes) and never touches a sibling case. A closed
case can be reopened if closed by mistake.

### 25b. Failure modes

- "Couldn't open the case (has-open-case)": the animal already has an
  open case of that type — work the existing one instead.
- "Couldn't link (has-open-case)": the target animal already has an
  open found case — reconcile those first.
- Owner says they reported missing but nothing shows: check the case's
  `reported_via` on detail — only `owner-portal` reports came from the
  portal; also confirm their ownership interval is still current (a
  closed interval can't file).
- Public page shows an animal that was found: resolution should have
  de-listed it — check the case status; if it resolved, the listing is
  gone (a cached page refresh may be all that's stale).
