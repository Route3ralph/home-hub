// Tests for supabase/cron.sql, the file that schedules hub-jobs. It runs for real in a throwaway
// Postgres (tests/db/cluster.sh), with small stand-ins for what Supabase provides: pg_cron's
// cron.schedule / cron.unschedule / cron.job / cron.job_run_details, pg_net's net.http_post and
// Vault's vault.decrypted_secrets. The two "create extension" lines can't run without the real
// extensions, so they are checked as text and then left out; everything else in the file runs.
// Needs the PostgreSQL 16 server binaries, like tests/db.
// Run alone with: node --experimental-strip-types tests/fn/cron-sql.test.ts
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${String(detail).slice(0, 300)})` : ''}`);
const ROOT = new URL('../../', import.meta.url).pathname;
const cronSql = readFileSync(join(ROOT, 'supabase/cron.sql'), 'utf8');
const SECRET = 'f3a1c97e5b2d48a6e0c1b7d9f2a4c6e8b0d3f5a7c9e1b2d4f6a8c0e2b4d6f8a1';   // made up for the test
const URL_OK = 'https://project.example/functions/v1/hub-jobs';

// ---- The text: pg_net goes into the extensions schema (Supabase's Security Advisor flags an
// extension in public, and pg_net can't be moved later without dropping it).
const lines = cronSql.split('\n').filter((l) => !/^\s*--/.test(l));
const netLines = lines.filter((l) => /create\s+extension[^;]*pg_net/i.test(l));
check('pg_net is created in the extensions schema, not public',
  netLines.length === 1 && /create extension if not exists pg_net with schema extensions;/i.test(netLines[0]), netLines.join(' | '));
const cronLines = lines.filter((l) => /create\s+extension[^;]*pg_cron/i.test(l));
check('pg_cron is created once', cronLines.length === 1, cronLines.join(' | '));

// ---- The stand-ins.
const STANDINS = `
create schema if not exists extensions;
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null, active boolean not null default true);
create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$
declare id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into id;
  return id;
end $$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = job_name;
  if not found then raise exception 'could not find valid entry for job ''%''', job_name; end if;
  return true;
end $$;
create schema net;
create table net.calls (url text, body jsonb, headers jsonb, timeout_milliseconds int);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language sql as $$ insert into net.calls values (url, body, headers, timeout_milliseconds); select 1::bigint; $$;
create schema vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
create function public.roll_missed_tasks() returns int language sql as $$ select 0 $$;
`;

// cron.sql without its two "create extension" lines (the stand-ins are already there).
const runnable = cronSql
  .replace(/^create extension if not exists pg_cron[^;]*;$/m, '-- (pg_cron: stand-in)')
  .replace(/^create extension if not exists pg_net[^;]*;$/m, '-- (pg_net: stand-in)');
check('the test can leave out the two "create extension" lines', !/^\s*create extension/im.test(runnable));

(async () => {
  // A throwaway server: cluster.sh starts it and removes it when this bash exits (stdin closes).
  const tmp = mkdtempSync(join(tmpdir(), 'hub-cron-'));
  const bash = spawn('bash', ['-c', 'source tests/db/cluster.sh && echo "READY $dir $port $PG_BIN" && read -r _'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready: string = await new Promise((resolve) => {
    let out = '';
    const done = (s: string) => resolve(s);
    bash.stdout.on('data', (b) => { out += b; const m = /READY .*\n/.exec(out); if (m) done(m[0].trim()); else if (/FAIL/.test(out)) done(out); });
    bash.on('exit', () => done(out || 'the server did not start'));
  });
  const stop = () => { try { bash.stdin.end(); } catch { /* gone */ } rmSync(tmp, { recursive: true, force: true }); };
  if (!ready.startsWith('READY ')) {
    check('a throwaway Postgres starts (tests/db/cluster.sh)', false, ready);
    stop();
    finish();
    return;
  }
  const [, sock, port, pgBin] = ready.split(' ');
  // psql as postgres; returns { ok, out, err }.
  const psql = (db: string, args: string[], input?: string) => {
    const r = spawnSync(`${pgBin}/psql`, ['-h', sock, '-p', port, '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-A', '-t', '-d', db, ...args],
      { input, encoding: 'utf8', env: { ...process.env, PGTZ: 'UTC', PGOPTIONS: '-c client_min_messages=warning' } });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const q = (sql: string) => psql('crontest', ['-c', sql]);
  const file = join(tmp, 'cron.sql');
  writeFileSync(file, runnable);
  const runCron = () => psql('crontest', ['-f', file]);

  try {
    let r = psql('postgres', ['-c', 'create database crontest']);
    r = r.ok ? psql('crontest', [], STANDINS) : r;
    check('stand-ins for pg_cron, pg_net and Vault load', r.ok, r.err);

    // ---- Refuses to schedule anything without real secrets.
    r = runCron();
    check('no Vault secrets: refused, nothing scheduled', !r.ok && /no secret named hub_cron_secret/.test(r.err) && q('select count(*) from cron.job').out === '0', r.err);
    q(`insert into vault.decrypted_secrets values ('hub_cron_secret', '<the secret>'), ('hub_jobs_url', '${URL_OK}')`);
    r = runCron();
    check('a placeholder secret: refused, nothing scheduled', !r.ok && /placeholder|at least 32/.test(r.err) && q('select count(*) from cron.job').out === '0', r.err);
    q(`update vault.decrypted_secrets set decrypted_secret = '${SECRET}' where name = 'hub_cron_secret'`);

    // ---- Schedules the jobs.
    r = runCron();
    const jobs = q("select jobname || ' ' || schedule from cron.job order by jobname").out.split('\n');
    check('with real secrets: hub-cron-cleanup (daily), hub-digest (every 15 minutes), hub-roll-missed (hourly)',
      r.ok && jobs.length === 3 && jobs[0].startsWith('hub-cron-cleanup ') && /^hub-cron-cleanup \d+ \d+ \* \* \*$/.test(jobs[0])
      && jobs[1] === 'hub-digest */15 * * * *' && jobs[2] === 'hub-roll-missed 7 * * * *', `${r.err} ${jobs.join(' | ')}`);
    r = runCron();
    check('running it again replaces the jobs (still three)', r.ok && q('select count(*) from cron.job').out === '3', r.err);

    // ---- The digest job reads the URL and the secret from Vault when it runs.
    const digestCmd = q("select command from cron.job where jobname = 'hub-digest'").out;
    r = psql('crontest', [], digestCmd.trim().replace(/;?\s*$/, ';'));
    const call = q("select url || ' ' || (headers->>'x-hub-cron') || ' ' || (body->>'action') from net.calls").out;
    check('the digest job posts {"action":"digest"} to the Vault URL with the Vault secret', r.ok && call === `${URL_OK} ${SECRET} digest`, `${r.err} ${call}`);
    check('neither secret is stored in the job itself', !digestCmd.includes(SECRET) && !digestCmd.includes(URL_OK));

    // ---- The cleanup job: cron.job_run_details would otherwise keep ~120 rows a day forever.
    q(`insert into cron.job (jobname, schedule, command) values ('family-backup', '0 2 * * *', 'select 1')`);
    q(`insert into cron.job_run_details (jobid, status, start_time, end_time) values
      ((select jobid from cron.job where jobname = 'hub-digest'), 'succeeded', now() - interval '20 days', now() - interval '20 days'),
      ((select jobid from cron.job where jobname = 'hub-digest'), 'succeeded', now() - interval '1 day', now() - interval '1 day'),
      ((select jobid from cron.job where jobname = 'hub-roll-missed'), 'failed', now() - interval '15 days', null),
      (987654, 'succeeded', now() - interval '30 days', now() - interval '30 days'),
      ((select jobid from cron.job where jobname = 'family-backup'), 'succeeded', now() - interval '40 days', now() - interval '40 days')`);
    const cleanCmd = q("select command from cron.job where jobname = 'hub-cron-cleanup'").out;
    r = psql('crontest', [], cleanCmd.trim().replace(/;?\s*$/, ';'));
    const left = q(`select string_agg(coalesce(j.jobname, 'gone') || ':' || extract(day from now() - d.start_time)::int, ',' order by d.runid)
                    from cron.job_run_details d left join cron.job j using (jobid)`).out;
    check('cleanup: the hub jobs\' run history older than 14 days goes, the last 2 weeks stay', r.ok && left.includes('hub-digest:1') && !left.includes('hub-digest:20') && !left.includes('hub-roll-missed:15'), `${r.err} ${left}`);
    check('cleanup: rows of jobs that no longer exist (an earlier hub-digest, say) go too', !left.includes('gone:'), left);
    check('cleanup: other jobs\' history is left alone', left.includes('family-backup:40'), left);
  } finally {
    stop();
  }
  finish();
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  process.exit(1);
});

function finish() {
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
}
