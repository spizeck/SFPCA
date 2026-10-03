# Pre-Launch Board Demo — Operator Runbook (#275)

This runbook operates the **temporary, production-hosted, pre-launch board
demo**: the real site at `https://www.sabafpca.com` is deliberately seeded
with clearly fictional data so the SFPCA board can explore every workflow
on their own devices. Before the first real SFPCA record is entered, the
entire demo footprint is removed and verified clean.

> **This workflow is only legal while production is pre-launch and empty.**
> The tooling enforces that. Once the lifecycle row reads `live`, every
> destructive command refuses permanently — enforced by a database trigger,
> not just a script check.

## Architecture summary

| Store | Role | Demo handling |
|---|---|---|
| Neon Postgres | Operational registry authority | Seeded with fictional rows; reset truncates all domain tables and deletes only demo-window rows from identity/audit tables |
| Firebase Auth | Sign-in | Three fictional demo accounts created at seed; demo-window users deleted at reset |
| Firestore | CMS/content (homepage, settings, FAQ, vet services, adoptions) | Filled only when empty; collections verified empty at seed are wiped at reset |
| Firebase Storage | Receipts, vet documents, team photos | Demo PDFs uploaded to empty prefixes; reset removes objects created inside the demo window |
| Resend (email) | Outbound reminders | **Inert demo-sink while pre-launch** — sends are recorded in the communications ledger but nothing leaves the platform (optional single-inbox override) |
| Sentry | Error monitoring | `NEXT_PUBLIC_SENTRY_ENVIRONMENT=prelaunch-demo` tags demo-window events so they never read as production |
| Vercel cron | Reminders, storage sweep | Reminders route through the demo sink; the object sweep is skipped outright while pre-launch |
| SEO | robots/sitemap/headers | `robots.txt` disallows all, sitemap is empty, every response carries `X-Robots-Tag: noindex` — all restored automatically at go-live |

## The lifecycle

`app_state` (single-row Postgres table, migration `0022`) is the durable
deployment lifecycle:

- `prelaunch-demo` — the demo tooling may run; banner + noindex + email
  sink are active.
- `live` — normal production. **One-way**: the `app_state_live_is_final`
  trigger rejects every UPDATE/DELETE of a live row. There is no code
  path — app or script — that can put production back into demo mode
  without a deliberate, audited `DROP TRIGGER` migration.

A *missing* row resolves to `live` (fail-safe): losing the row can never
re-enter demo presentation.

## Demo accounts

Three fictional accounts are created at seed (passwords come from
`DEMO_ACCOUNT_PASSWORD`, never from the repo):

| Email | Role | Use |
|---|---|---|
| `sfpca.demo.admin@example.com` | Admin (`admin_users` row) | Board explores the staff application |
| `sfpca.demo.owner@example.com` | Owner (linked person, 3 animals) | Owner portal walkthrough |
| `sfpca.demo.user@example.com` | Plain user | Permission-boundary demonstration |

All addresses are on the reserved `example.com` domain — no real person
can ever be contacted or impersonated by them.

## Commands

All commands run from the repo root with `.env.local` populated:

```bash
npm run production-demo:check                   # read-only audit
npm run production-demo:status                  # read-only state report
npm run production-demo:verify                  # read-only clean proof
npm run production-demo -- seed    --production --confirm "SEED PRODUCTION DEMO"
npm run production-demo -- reset   --production --confirm "RESET PRODUCTION DEMO"
npm run production-demo -- go-live --production --confirm "GO LIVE"
```

Local sandbox variants (PGlite/emulator targets) use `--local` and the
`*LOCAL*` phrases; `--local` hard-refuses if the emulator env vars are
absent or the database host resolves to the production Neon endpoint.

`seed` and `reset` in production mode additionally require:

- `FIREBASE_ADMIN_PROJECT_ID` === `saba-sfpca`
- `NEON_API_KEY` set, and `DATABASE_URL`/`DATABASE_URL_UNPOOLED` pointing
  at an endpoint of the Neon **primary** branch
- `DEMO_ACCOUNT_PASSWORD` (seed only, ≥8 chars)
- lifecycle `prelaunch-demo` (database-enforced)
- every domain table **empty** (seed only)

## Before the board demo

1. **Deploy** the reviewed build including migration `0022` — the
   `app_state` row is created as `prelaunch-demo` automatically.
2. **Vercel env**: confirm `NEXT_PUBLIC_SENTRY_ENVIRONMENT=prelaunch-demo`
   is set for the production deployment; ensure `SITE_MAINTENANCE_MODE`
   is **off** so the board can reach the site.
3. **Operator env** (`.env.local`): `DATABASE_URL`/`DATABASE_URL_UNPOOLED`,
   `FIREBASE_ADMIN_*`, `NEON_API_KEY`, `ADMIN_EMAILS`,
   `DEMO_ACCOUNT_PASSWORD`.
4. **Audit**: `npm run production-demo:check` — verify identity lines,
   `lifecycle=prelaunch-demo`, all domain tables empty, migrations
   current, stores reachable.
5. **Seed**:
   `npm run production-demo -- seed --production --confirm "SEED PRODUCTION DEMO"`
   — creates a pre-seed Neon snapshot automatically, then seeds.
6. **Confirm**: `npm run production-demo:status` — baseline counts shown.
7. **Smoke test** one page of each surface (public, /admin, /portal) —
   the amber PRE-LAUNCH DEMO banner must be visible everywhere.
8. **Send** the board `https://www.sabafpca.com` plus the demo account
   credentials through a secure channel.

## During the demo

- Board members may create/edit/delete freely — mutations persist.
- `npm run production-demo:status` shows additions since seed.
- **Email**: nothing real is sent. Sends appear in the admin
  communications ledger under provider `demo-sink`. To show a real
  delivered email, set `DEMO_EMAIL_OVERRIDE_TO=<one-owner-inbox>` before
  triggering a send — every message is rewritten to that single address.
- A mid-demo **reset** restores a clean slate:
  `npm run production-demo -- reset --production --confirm "RESET PRODUCTION DEMO"`
  (you may then re-seed — the lifecycle is still `prelaunch-demo`).

## After the demo — going live

1. Optionally stop board access (re-enable `SITE_MAINTENANCE_MODE`).
2. `npm run production-demo -- reset --production --confirm "RESET PRODUCTION DEMO"`
3. `npm run production-demo:verify` — must print `VERIFY-CLEAN PASS`.
4. Independently spot-check: `npm run db:preview` counts, the Firebase
   console (Auth users, Storage objects), Firestore collections.
5. `npm run production-demo -- go-live --production --confirm "GO LIVE"`
   — refuses unless verify passes; the transition is permanent.
6. Prove the tooling is retired:
   `npm run production-demo -- seed --production --confirm "SEED PRODUCTION DEMO"`
   must now print a refusal.
7. Remove `NEXT_PUBLIC_SENTRY_ENVIRONMENT` from Vercel (next deploy
   reports `production` again).
8. Verify on the live site: banner gone, `robots.txt` shows normal rules,
   `/api/app-state` returns `{"lifecycle":"live"}`.
9. Only now allow the first real SFPCA record.

## What the seed contains (seed version 1)

- **11 people** incl. a deliberately incomplete record and a duplicate
  person candidate (same name + phone)
- **3 households** incl. a same-address duplicate household
- **19 animals**: dogs/cats/other; chipped and not; sterilized/intact/
  unknown; adoption available ×3, pending, adopted; missing; deceased;
  moved-off-island; a duplicate-animal pair sharing a microchip scan
- **16 registrations**: current + 2 prior years; paid (cash/bank),
  unpaid, partially-refunded, failed payment, complimentary resolution,
  withdrawn cancellation
- **9 ledger payments** + 16 payment events
- **8 microchip records** + 1 open chip conflict
- **3 lost/found cases** (open missing + sightings, resolved reunited,
  open found stray) + 5 updates
- **Medical**: 6 encounters, 3 procedures, 2 medications, 2 alerts
  (critical allergy + resolved), 6 weight records, 10 vaccinations
  (current/due-soon/overdue), 1 vet document + PDF
- **Queues**: 3 follow-ups (incl. overdue), 3 clinic expectations
- **2 owner requests** (pending transfer, approved deceased)
- **4 communications** (delivered/failed/skipped/queued) + 1 opt-out
- **4 registration submissions** (2 pending — one with receipt PDF,
  1 approved, 1 rejected)
- **CMS**: homepage, site settings, 8 FAQs, vet services, adoptions,
  registration content (only where collections were empty)

## Failure modes

- **"production is NOT empty"** — the gate found pre-existing rows.
  Nothing was changed. Review with the owner; do NOT guess at removal.
- **"a demo seed is already applied"** — reset first.
- **"demo lifecycle is not engaged"** — the database is live or the row
  is absent. Demo tooling cannot run. This is the permanent safety rail.
- **Seed partially fails** (e.g. Storage upload error): re-run
  `check`, inspect `demo_seed_runs`, and `reset` before retrying.
