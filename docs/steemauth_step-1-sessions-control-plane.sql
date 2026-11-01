-- ============================================================
-- SteemAuth step 1 of 3 — SESSIONS CONTROL PLANE: steemauth_sessions
-- ============================================================
--
-- WHO NEEDS THIS STEP
--   SteemAuthenticator operators only. Integrators need NO SQL at all in
--   protocol v3: sessions travel over the token-authenticated relay
--   (steemauth-relay), whose rooms are created by the client handshake.
--
-- WHAT IT IS
--   Revocation must outlive any single connection. Live frames travel over
--   the v3 relay; THIS table is the control plane:
--   "this session is revoked" is a fact BOTH sides must observe even when
--   the phone is backgrounded — the phone writes it, the web app subscribes
--   to it, and expiry is a row value rather than a guess.
--
--
-- WHAT IS STORED
--   Session id, account, requesting app, lifecycle timestamps. NEVER keys,
--   signatures, operation payloads — or the requesting origin: reads are
--   scoped to the anon key only, and a world-readable list of "which account
--   visited which site" would be a tracking log. The phone keeps that detail
--   locally for its Sessions tab; the web app only ever queries its own sid.
--
-- PRINCIPAL MODEL
--   The anon key identifies both peers (phone and web app) equally, so RLS
--   cannot tell them apart. Everything below shapes what that ONE identity
--   may DO rather than who is asking. Residual risk, stated plainly: anyone
--   holding the anon key can enumerate sessions and see account, app name
--   and timestamps. They cannot create a dead session, extend one, rebind
--   it, or clear a revocation. If that enumeration is unacceptable, drop
--   `account` and `app_name` (both sides only ever need their own sid)
--   rather than weakening realtime.
--
-- IDEMPOTENT: safe to re-run.
-- ORDER: independent (step 1 has no foreign keys to this table).
-- ============================================================

-- --------------------------------------------------------------------
-- 2.1 Schema
-- --------------------------------------------------------------------
create table if not exists public.steemauth_sessions (
  -- The session id from the QR payload: a uuid that only appears inside the
  -- QR, so knowing it is itself the capability to act on the row — the same
  -- property relay-room names relied on.
  sid            text primary key check (length(sid) >= 8),
  account        text not null,
  app_name       text not null default 'unknown',
  created_at     timestamptz not null default now(),
  -- QR expiry (payload `exp`). Once passed the phone refuses the code, so a
  -- row past this time is inert even if it was never explicitly revoked.
  expires_at     timestamptz not null,
  -- Set exactly once, by the user revoking the app in the Sessions tab.
  revoked_at     timestamptz,
  revoked_reason text
);

-- Finding an expired-or-revoked session must stay cheap; the phone checks it
-- before every approval.
create index if not exists steemauth_sessions_expiry_idx
  on public.steemauth_sessions (expires_at)
  where revoked_at is null;

create index if not exists steemauth_sessions_account_idx
  on public.steemauth_sessions (account, created_at desc);

-- Realtime (Postgres changes) is how a revocation reaches a connected web
-- app. A table outside the publication simply never emits events — this is
-- the line most likely to be forgotten.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'steemauth_sessions'
  ) then
    alter publication supabase_realtime add table public.steemauth_sessions;
  end if;
end $$;

-- --------------------------------------------------------------------
-- 2.2 Role privileges (RLS in 2.3 is inert without these)
-- --------------------------------------------------------------------
-- The column list on UPDATE is the load-bearing control: anon can insert,
-- read, and move a row INTO the revoked state — and nothing else. Column
-- grants are what stop a holder of the shared key from extending its own
-- expiry or rebinding a session.
grant usage on schema public to anon, authenticated;
grant select on public.steemauth_sessions to anon, authenticated;
grant insert on public.steemauth_sessions to anon, authenticated;
grant update (revoked_at, revoked_reason) on public.steemauth_sessions to anon, authenticated;

-- --------------------------------------------------------------------
-- 2.3 Policies
-- --------------------------------------------------------------------
alter table public.steemauth_sessions enable row level security;

drop policy if exists "anon can read sessions" on public.steemauth_sessions;
drop policy if exists "anon can create sessions" on public.steemauth_sessions;
drop policy if exists "anon can revoke sessions" on public.steemauth_sessions;

-- Select is open because Postgres Changes only emits rows the subscriber may
-- read, and realtime is the entire point of this table.
create policy "anon can read sessions"
  on public.steemauth_sessions
  for select to anon
  using (true);

-- A row must be born live: not pre-revoked, not expired, and — new hardening
-- against un-sweepable row squatting — not absurdly far in the future. The
-- app's own standing grants last 7 days (SESSION_GRANT_TTL_MS), so 8 days
-- is the honest ceiling; without it a pre-registered far-future expiry is
-- NEVER collected by the sweeper.
create policy "anon can create sessions"
  on public.steemauth_sessions
  for insert to anon
  with check (
    revoked_at is null
    and expires_at > now()
    and expires_at <= now() + interval '8 days'
    and length(sid) >= 8
  );

-- `with check` sees the NEW row, so requiring revoked_at to be set means the
-- only transition anon can perform is live -> revoked. Clearing a revocation
-- would leave revoked_at null and be rejected, and the column grant stops
-- anyone touching expires_at to push an expiry out.
create policy "anon can revoke sessions"
  on public.steemauth_sessions
  for update to anon
  using (true)
  with check (revoked_at is not null);

-- --------------------------------------------------------------------
-- 2.4 Verify (run by hand)
-- --------------------------------------------------------------------
-- Should return rows / no error:
--   select sid, account, revoked_at from public.steemauth_sessions limit 5;
-- Should fail (anon cannot delete):
--   delete from public.steemauth_sessions limit 1;
-- Should fail (anon cannot un-revoke):
--   update public.steemauth_sessions set revoked_at = null where sid = '...';
-- Should fail (expiry beyond the ceiling):
--   insert into public.steemauth_sessions (sid, account, expires_at)
--   values ('aaaaaaaa-1111', 'alice', now() + interval '90 days');
--
-- Cleanup: with no delete grant, expired rows accumulate until step 4's
-- sweeper collects them (7-day retention after expiry, hourly).
