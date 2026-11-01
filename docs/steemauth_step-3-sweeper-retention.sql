-- ============================================================
-- SteemAuth step 3 of 3 — SWEEPER (scheduled retention)
-- ============================================================
--
-- (Protocol v3 retired the v2 Supabase message plane and its step-1 DDL:
--  sessions now travel over the token-authenticated relay, whose own sweeper
--  lives in steemauth-relay. What remains append-only here is the CONTROL
--  plane.)
--
-- WHO NEEDS THIS STEP
--   SteemAuthenticator operators. Runs what the append-only RLS can never
--   remove: anon has no DELETE on steemauth_sessions or steemauth_activity,
--   so a scheduled job with elevated rights is the ONLY collector.
--
-- WHAT IT REMOVES
--   steemauth_sessions  expired more than 7 days ago (a week kept for audit),
--                       or with a far-future expiry beyond the 8-day insert
--                       ceiling (pre-cap rows / policy-violating writers)
--   steemauth_activity  older than 90 days (approval history has no other
--                       deletion path; adjust the interval to taste)
--
-- IDEMPOTENT: safe to re-run.
-- ORDER: run last (it references the tables from steps 1-2).
--
-- HOW TO SCHEDULE
--   * Supabase (pg_cron installed — default on hosted projects):
--       run this whole file in the SQL editor once. The last block schedules
--       an hourly run at :17 and prints a notice if pg_cron is missing.
--   * Supabase Dashboard without pg_cron: Database -> Functions ->
--       create `steemauth_sweep` from section 1, then add a scheduled job
--       (Extensions -> Scheduled Functions) that runs it hourly.
--   * Self-hosted: any scheduler — pg_cron, cron(8) or a container job:
--       psql "$DATABASE_URL" -c 'select public.steemauth_sweep();'
--
-- The job must NOT run as `anon` (it has no delete grant by design): run it
-- as the postgres/service-role user. `security definer` below makes that
-- explicit even when invoked through a restricted role.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The function
-- ------------------------------------------------------------
create or replace function public.steemauth_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $body$
begin
  -- Sessions: one week past expiry, then gone. The far-future arm collects
  -- rows that predate the step-1 insert ceiling (or came from a writer that
  -- bypassed the policy): an expiry more than 8 days out can never be
  -- legitimate and would otherwise NEVER be swept.
  delete from public.steemauth_sessions s
  where s.expires_at < now() - interval '7 days'
     or s.expires_at > now() + interval '8 days';

  -- Activity: approval history is metadata-only but unbounded by design
  -- (no delete grant); keep 90 days, drop the rest.
  delete from public.steemauth_activity a
  where a.at < now() - interval '90 days';
end;
$body$;

-- Only elevated roles may run it (anon/authenticated have no DELETE anyway).
revoke execute on function public.steemauth_sweep() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.steemauth_sweep() to service_role';
    raise notice 'steemauth_sweep: granted to service_role';
  else
    raise notice 'steemauth_sweep: no service_role (not Supabase?) - owner runs it directly';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 2. Schedule (pg_cron when available)
-- ------------------------------------------------------------
do $body$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed - schedule public.steemauth_sweep() manually (hourly)';
    return;
  end if;

  -- Re-scheduling must be idempotent: drop any previous version of this job.
  if exists (select 1 from cron.job where jobname = 'steemauth-sweep') then
    perform cron.unschedule('steemauth-sweep');
    raise notice 'steemauth_sweep: replaced existing schedule';
  end if;

  -- Hourly, at :17 — deliberately off the top of the hour so the sweep never
  -- collides with the minute-0 load spikes.
  perform cron.schedule(
    'steemauth-sweep',
    '17 * * * *',
    $cron$ select public.steemauth_sweep(); $cron$
  );
  raise notice 'steemauth_sweep: scheduled hourly at :17';
end;
$body$;
