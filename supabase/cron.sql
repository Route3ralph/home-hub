-- =====================================================================
-- HOME HUB v2 — schedule the morning email and the Google Calendar copy (pg_cron + pg_net)
-- Run in the Supabase SQL editor after migration 0002 is applied and the
-- hub-jobs function is deployed (docs/v2-design.md §7, step 5), and again after
-- a release that changes this file (v1.1 added hub-calendar: run it again after
-- migration 0003). Safe to run again: it replaces the four jobs. It changes
-- nothing if a check fails.
--
-- Before you run it, create two Vault secrets by hand (Dashboard → Project
-- Settings → Vault, or in the SQL editor). Never write the real values in
-- this file or anywhere else in the repository: it is public.
--
--   hub_cron_secret  the same value as the function's HUB_CRON_SECRET secret:
--                    at least 32 random characters, e.g. from  openssl rand -hex 32
--       select vault.create_secret('<the secret>', 'hub_cron_secret', 'x-hub-cron header for hub-jobs');
--
--   hub_jobs_url     the function's address (Dashboard → Edge Functions → hub-jobs)
--       select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/hub-jobs', 'hub_jobs_url', 'hub-jobs URL for pg_cron');
--
-- To change either later, update the Vault secret; there's no need to run this
-- file again, because the job reads both each time it runs:
--       select vault.update_secret(id, '<new value>') from vault.secrets where name = 'hub_cron_secret';
--
-- What it schedules
--   hub-digest        every 15 minutes: POST {"action":"digest"} to hub-jobs with the
--                     x-hub-cron header. Each run sends whatever is due. digest_due looks
--                     back 3 hours, so a run that is late, or that fails as a whole, is
--                     caught up by the next one. An email that fails on its own is tried
--                     again by later runs, a limited number of times (claim_notification
--                     and digest_due in migration 0002 decide how often and how far apart).
--   hub-roll-missed   every hour: moves missed repeating tasks on, so the pages are right
--                     even when nobody gets an email (hub-jobs also does it before each run).
--   hub-calendar      every 5 minutes, at 2, 7, 12 … 57 (away from hub-digest's quarter hours):
--                     POST {"action":"calendar"} to hub-jobs with the same header. Each run copies
--                     hub items to the Google calendars and reads Google's events back
--                     (docs/v1.1-google-calendar.md §3). Until migration 0003 is applied it
--                     answers 503 no_schema, and without GOOGLE_SA_JSON it stops at once
--                     (not_set_up): harmless either way.
--   hub-cron-cleanup  every night: removes the hub jobs' run history (cron.job_run_details)
--                     older than 14 days. Without it the ~400 rows a day are kept forever.
--
-- hub-jobs must be deployed with JWT verification off (supabase/config.toml pins it). If it
-- isn't, the gateway answers every run with 401 before the function starts, and pg_cron still
-- logs "succeeded" (net.http_post only queues the call): look in net._http_response.
-- =====================================================================

begin;

-- 1. The extensions: pg_cron runs jobs on a schedule, pg_net lets a job make an
--    HTTP request. Both come with Supabase; this switches them on if they're off.
--    pg_net goes into the extensions schema, as Supabase recommends: its control file names
--    no schema, so it would land in public (the Security Advisor flags that, and it can't be
--    moved later without dropping it). Its functions are in the net schema either way.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- 2. Refuse to go on until both Vault secrets are there and real. hub-jobs answers
--    503 to every run while its own HUB_CRON_SECRET is shorter than 32 characters,
--    and 401 while the two values differ.
do $$
declare
  secret text;
  url    text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Vault is not available in this database, so the secrets can''t be read. Nothing was scheduled.';
  end if;

  select s.decrypted_secret into secret from vault.decrypted_secrets s where s.name = 'hub_cron_secret';
  if secret is null then
    raise exception 'Vault has no secret named hub_cron_secret. Create it first (see the top of this file). Nothing was scheduled.';
  end if;
  if length(secret) < 32 then
    raise exception 'The Vault secret hub_cron_secret has % characters; it needs at least 32 (and must equal the function''s HUB_CRON_SECRET). Nothing was scheduled.',
      length(secret);
  end if;
  -- Placeholder words, angle brackets from the examples above, or too few different
  -- characters (like 32 x's) mean it was never replaced with a random value.
  if secret ~* '(change|replace|placeholder|paste|secret|example|your|todo|xxxx|<|>)'
     or (select count(distinct c) from regexp_split_to_table(secret, '') c) < 10 then
    raise exception 'The Vault secret hub_cron_secret looks like a placeholder. Use a random value (e.g. openssl rand -hex 32), and the same one for HUB_CRON_SECRET. Nothing was scheduled.';
  end if;

  select s.decrypted_secret into url from vault.decrypted_secrets s where s.name = 'hub_jobs_url';
  if url is null then
    raise exception 'Vault has no secret named hub_jobs_url. Create it first (see the top of this file). Nothing was scheduled.';
  end if;
  if url !~ '^https://[^/[:space:]<>]+/functions/v1/hub-jobs$' or url ~* '(project-ref|<|>)' then
    raise exception 'The Vault secret hub_jobs_url should look like https://<project-ref>.supabase.co/functions/v1/hub-jobs, with your project''s address. Nothing was scheduled.';
  end if;
end;
$$;

-- 3. The morning email, every 15 minutes. The URL and the secret are read from
--    Vault when the job runs, so neither is stored in the job's command (cron.job).
--    The timeout gives a run with a full batch (20 emails) time to finish.
select cron.unschedule(j.jobname) from cron.job j where j.jobname = 'hub-digest';
select cron.schedule(
  'hub-digest',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'hub_jobs_url'),
    body := '{"action": "digest"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hub-cron', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'hub_cron_secret')),
    timeout_milliseconds := 60000
  );
  $job$
);

-- 4. Missed repeating tasks, every hour at 7 minutes past (away from the busy top
--    of the hour). Runs in the database itself; no HTTP call.
select cron.unschedule(j.jobname) from cron.job j where j.jobname = 'hub-roll-missed';
select cron.schedule('hub-roll-missed', '7 * * * *', 'select public.roll_missed_tasks()');

-- 5. The Google Calendar copy, every 5 minutes, at minutes 2, 7, 12 … 57. A run stops calling
--    Google after 30 seconds, so the same 60-second timeout covers it; what's left goes in the
--    next run. Reads the same two Vault secrets as hub-digest when it runs.
select cron.unschedule(j.jobname) from cron.job j where j.jobname = 'hub-calendar';
select cron.schedule(
  'hub-calendar',
  '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
  $job$
  select net.http_post(
    url := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'hub_jobs_url'),
    body := '{"action": "calendar"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hub-cron', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'hub_cron_secret')),
    timeout_milliseconds := 60000
  );
  $job$
);

-- 6. Housekeeping, every night at 3:17 (UTC): pg_cron keeps a row per run in
--    cron.job_run_details and never removes them. This keeps the hub jobs' last 14 days
--    (and drops rows of jobs that no longer exist, such as the ones this file replaced);
--    other jobs' history is left alone.
select cron.unschedule(j.jobname) from cron.job j where j.jobname = 'hub-cron-cleanup';
select cron.schedule(
  'hub-cron-cleanup',
  '17 3 * * *',
  $job$
  delete from cron.job_run_details d
  where coalesce(d.end_time, d.start_time) < now() - interval '14 days'
    and (d.jobid in (select j.jobid from cron.job j where j.jobname like 'hub-%')
         or not exists (select 1 from cron.job j where j.jobid = d.jobid));
  $job$
);

commit;

-- 7. Check: the four jobs are listed and active.
select jobid, jobname, schedule, active from cron.job where jobname in ('hub-digest', 'hub-roll-missed', 'hub-calendar', 'hub-cron-cleanup') order by jobname;

-- Afterwards, to see how it is going:
--   select jobname, status, return_message, start_time from cron.job_run_details d
--     join cron.job j using (jobid) where j.jobname like 'hub-%' order by start_time desc limit 10;
--   select status_code, error_msg, created from net._http_response order by created desc limit 10;
--   select started_at, ok, sent, detail from public.job_runs order by started_at desc limit 10;
-- To stop the morning email:   select cron.unschedule('hub-digest');
-- To stop the Google Calendar copy:   select cron.unschedule('hub-calendar');
-- To remove everything this file scheduled:
--   select cron.unschedule(j.jobname) from cron.job j where j.jobname in ('hub-digest', 'hub-roll-missed', 'hub-calendar', 'hub-cron-cleanup');
