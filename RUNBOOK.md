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
Firestore content write ──► onFirestoreChange ──► deploy hook POST
(scheduled every 24 h)  ──► sweepOrphanedReceipts ──► Storage cleanup
(authenticated HTTPS)   ──► triggerRebuild ──► same deploy hook

Firebase deploy (manual, CLI):
  functions/  ──► Cloud Functions (+ Cloud Scheduler for the sweep)
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
| `sweepOrphanedReceipts` | `functions/index.js`, `functions/lib/sweep.js` | Cloud Functions + Cloud Scheduler | manual `firebase deploy` (schedule is part of the function definition) | Firebase console → Functions / Cloud Scheduler | Cloud Logging, `subsystem:"receipt-cleanup"` |
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
| `ADMIN_EMAILS` | Bootstrap admin allowlist (comma-separated) | yes-ish — emails are personal data |
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

**Deploy everything (all three functions + the sweep schedule):**

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
firebase deploy --only functions:sweepOrphanedReceipts
```

**Verify:**

```bash
firebase functions:log                          # recent executions
firebase functions:log --only onFirestoreChange # one function
```

Firebase console → Functions shows deployed revisions, trigger type,
and error rate. For `sweepOrphanedReceipts`, also confirm the job exists
in Google Cloud console → Cloud Scheduler **[console]** (created by the
deploy; `every 24 hours`).

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
  **not** change Firestore/Storage rules — public form creates in
  `animalRegistrations` are still accepted by the rules layer, and
  Firebase Functions keep running normally.

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
   on `onFirestoreChange` / `sweepOrphanedReceipts` since the deploy.
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
§17 — PITR and managed backup state, the audited current posture, and the
full restore procedure. **As of the §17 audit (2026-09-22) production had
neither enabled** — until Chad completes §17b, deleted or corrupted
Firestore data is unrecoverable. Firebase Storage objects are a separate
boundary (§17e).

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
  → which function? onFirestoreChange | triggerRebuild | sweepOrphanedReceipts
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
  → Cloud Logging subsystem:"receipt-cleanup": a failed execution or
    outcome:"partial-failure" summary means orphans remain; the next
    daily run retries them (idempotent). Investigate the errorCode on
    per-object warn entries. Registration IDs/receipt names are
    deliberately never logged — inspect Storage directly if needed.
```

## 14. Automatic content rebuilds (post-#94)

A write to a **content collection** — `homepage`, `siteSettings`,
`animals`, `faq`, `vetServices`, `animalAdoptions`, `animalRegistration`
(`REBUILD_COLLECTIONS` in `functions/index.js`) — triggers
`onFirestoreChange`, which POSTs the configured Vercel deploy hook, and
Vercel starts a new deployment. Writes with no actual data change are
skipped. Writes to `animalRegistrations` (private submissions) and
`admins` trigger **nothing** — by design, and so their document paths
never enter the logs.

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

Until §17b is completed, **production Firestore data is unrecoverable
once deleted or corrupted.**

### 17b. Enable protection — manual operator step (Chad)

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
| `animals/*` — animal records | yes |
| `animalRegistrations/*` — owner PII + receipt references | yes |
| `admins/*` — admin allowlist | yes |
| `receipts/*` in Storage — payment receipt images/PDFs | **no** |
| `team-photos/*` in Storage — public images | **no** |

A restored `animalRegistrations` document may reference a `receipts/`
object that no longer exists (and vice versa — `sweepOrphanedReceipts`
deletes Storage objects whose registration document is gone, so an old
backup's registrations can point at swept receipts). Storage recovery
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
| **Soft delete** | **ENABLED — 7-day retention** (platform default since bucket creation) |
| Object Versioning | disabled |
| Lifecycle rules | none |
| Retention policy / bucket lock | none |
| Public access prevention | inherited (project); receipts stay private via Storage rules |
| Uniform bucket-level access | off (fine-grained — normal for Firebase) |
| Bucket ACL | project team only — no public/allUsers entries |

### 18b. Production change — manual operator step (Chad)

Soft delete is already on; the only recommended change is **extending
the retention window to 56 days** so it matches the 8-week Firestore
backup horizon (§17b). A Firestore backup restore can resurrect a
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

> Receipt object names are registration document IDs — treat them as
> sensitive. Query a specific object path; do **not** dump whole-prefix
> listings into terminals, tickets, or logs. Never download a receipt
> just to check it exists — validate via metadata.

1. **Identify the object.** From the `animalRegistrations` document,
   the `paymentReceipt` field holds the path `receipts/<doc id>`.
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

### 18e. Orphan-sweeper interaction (`sweepOrphanedReceipts`)

The sweeper (functions, every 24 h) deletes `receipts/<id>` objects
whose `animalRegistrations/<id>` document does not exist and which are
older than one hour. Two properties matter for recovery:

- **Soft-deleted receipts are invisible to the sweeper** — its listing
  sees live objects only. A swept receipt stays recoverable for the
  whole soft-delete window.
- **Firestore restore ordering hazard:** while a Firestore restore is
  in progress, a receipt can look orphaned if its registration document
  is absent from `(default)`. With delete protection now on,
  `(default)` cannot be removed — restores create *new* databases — so
  `(default)` stays populated. Still, as cheap insurance during any
  §17d restore that leaves registrations temporarily missing: **pause
  the sweeper's Cloud Scheduler job first** (Google Cloud console →
  Cloud Scheduler → `firebase-schedule-sweepOrphanedReceipts-*` →
  Pause), and resume it after recovery completes.

**Combined incident ordering** (registration doc + receipt both gone):

1. Pause the sweeper job (above).
2. Recover the Firestore document first per §17d — the document's
   `paymentReceipt` field tells you the exact object name.
3. Restore the Storage object per §18d, then resume the sweeper.
4. Validate the pair in the admin UI before reopening the site.

If the document is restored but its receipt is beyond the soft-delete
window, the registration record remains valid — only the attachment is
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
