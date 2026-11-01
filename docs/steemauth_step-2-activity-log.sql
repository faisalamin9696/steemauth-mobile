-- ============================================================
-- SteemAuth step 2 of 3 — ACTIVITY LOG: steemauth_activity
-- ============================================================
--
-- WHO NEEDS THIS STEP
--   SteemAuthenticator operators only. The app's Activity tab reads this
--   table; integrators can skip it (approval flow works without it).
--
-- WHAT IT IS
--   Approval-history metadata: account name, operation label, requesting
--   app name, success flag, txId, error text and a timestamp.
--   NEVER keys, WIFs, signatures or operation payloads.
--
-- PRINCIPAL MODEL
--   Same shared-anon-key shape as steps 1-2: insert + select for anon,
--   nothing else. There is no per-account server-side scoping (the client
--   filters by account), so a holder of the anon key can read every row's
--   metadata — including error strings the RPC layer returned. Keep the
--   app's own logging discipline (no payload material in error text) and
--   this table stays metadata-only. Retention: step 4's sweeper.
--
-- IDEMPOTENT: safe to re-run.
-- ORDER: none.
-- ============================================================

-- --------------------------------------------------------------------
-- 3.1 Schema
-- --------------------------------------------------------------------
create table if not exists public.steemauth_activity (
  id         text primary key,          -- request id (uuid)
  account    text not null,
  action     text not null,             -- e.g. "vote", "3 operations"
  app_name   text not null default 'unknown',
  ok         boolean not null,
  tx_id      text,
  error      text,
  at         timestamptz not null default now()
);

create index if not exists steemauth_activity_at_idx
  on public.steemauth_activity (at desc);

-- --------------------------------------------------------------------
-- 3.2 Role privileges (RLS below is useless without these grants)
-- --------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert on public.steemauth_activity to anon, authenticated;

-- --------------------------------------------------------------------
-- 3.3 Policies
-- --------------------------------------------------------------------
alter table public.steemauth_activity enable row level security;

drop policy if exists "anon can insert activity" on public.steemauth_activity;
drop policy if exists "anon can read activity" on public.steemauth_activity;

create policy "anon can insert activity"
  on public.steemauth_activity
  for insert to anon
  with check (true);

create policy "anon can read activity"
  on public.steemauth_activity
  for select to anon
  using (true);

-- --------------------------------------------------------------------
-- 3.4 Verify (run by hand)
-- --------------------------------------------------------------------
-- Should return rows, not an error:
--   select id, action, ok from public.steemauth_activity order by at desc limit 5;
-- Should fail (anon cannot delete — only step 4's sweeper ever removes rows):
--   delete from public.steemauth_activity limit 1;
