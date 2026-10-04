-- One-time pre-launch lifecycle correction (#278).
--
-- Context: migration 0023 initializes app_state to 'live' whenever the
-- database already carries domain rows — correct behavior for a real
-- registry. Production was found to hold only known legacy seeded/test
-- artifacts (owner-confirmed: no live data exists), which the one-time
-- cleanup script (scripts/cleanup-prelaunch-legacy-seed.ts) removes
-- first. This migration then returns the lifecycle to 'prelaunch-demo'
-- exactly once so the board-demo tooling (#275) can engage.
--
-- Preconditions — ALL must hold for the transition to fire:
--   - lifecycle = 'live' AND live_at IS NULL: 'live' came from the
--     0023 init, never from a real go-live (transitionToLive always
--     stamps live_at). Any other state is skipped as a no-op, so a
--     properly-live database can never be reopened by replay.
--   - every domain table empty: the legacy cleanup already ran and
--     removed the known fixture rows. ANY non-empty domain table
--     aborts the whole migration — this file can never silently flip
--     a registry that still holds records. (The exempt set mirrors
--     scripts/lib/demo-db.ts: tooling tables, preserved-by-window
--     bootstrap/identity tables, ephemeral rate-limit state.)
--
-- The finality trigger is disabled and re-enabled inside the same
-- transaction, so there is no window where a 'live' row is
-- unprotected, and a failure at any point rolls back including the
-- trigger state. This is deliberately a journaled migration, not a
-- stored procedure and not runtime code: it executes once, under
-- drizzle journal control, against the documented pre-launch
-- condition only — there is no reusable path that toggles lifecycle
-- backward.

DO $$
DECLARE
  st record;
  t record;
  n bigint;
BEGIN
  SELECT lifecycle, live_at INTO st FROM app_state WHERE id = 1;

  -- Not the remediation case → nothing to do. Covers fresh databases
  -- ('prelaunch-demo'), properly-live registries (live_at stamped),
  -- and any replay of this migration.
  IF st IS NULL OR st.lifecycle <> 'live' OR st.live_at IS NOT NULL THEN
    RAISE NOTICE '0024: lifecycle remediation not applicable (lifecycle=%, live_at=%) — skipping',
      coalesce(st.lifecycle::text, 'absent'), st.live_at;
    RETURN;
  END IF;

  -- The remediation case: 'live' was migration-initialized with data
  -- present. Every domain table must now be empty — the cleanup
  -- script removed the known legacy rows first. Refuse loudly rather
  -- than flip a registry that still holds records.
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN (
        'app_state', 'demo_seed_runs', 'demo_seed_entities',
        'household_members', 'admin_users', 'auth_identities',
        'households', 'audit_events', 'persons', 'rate_limit_windows'
      )
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', t.tablename) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION '0024: domain table % still holds % row(s) — run scripts/cleanup-prelaunch-legacy-seed.ts before applying this migration', t.tablename, n;
    END IF;
  END LOOP;

  -- Disable the finality trigger, flip, re-arm — all inside this one
  -- transaction so the guard is never persistently off.
  ALTER TABLE app_state DISABLE TRIGGER app_state_live_is_final;
  UPDATE app_state
     SET lifecycle = 'prelaunch-demo',
         demo_seeded_at = NULL,
         demo_seed_version = NULL,
         updated_at = now()
   WHERE id = 1;
  ALTER TABLE app_state ENABLE TRIGGER app_state_live_is_final;
  RAISE NOTICE '0024: lifecycle returned to prelaunch-demo; finality trigger re-armed';
END $$;
