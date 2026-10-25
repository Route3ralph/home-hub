-- The v1 security rules (from schema.sql) still hold after the migrations.
-- Ported from the original dbtest.sh: each check runs in its own transaction and is rolled back.
-- Data: v1_data.sql (Alex is the admin, Sam a member, Pat Lee a contractor, Kitchen a shared project).
\ir roles.sql

begin; :as_anon
select test.is((select count(*) from projects), 0::bigint, 'anon sees no projects');
rollback;
begin; :as_anon
select test.is((select count(*) from contractors), 0::bigint, 'anon sees no contractors');
rollback;
begin; :as_anon
select test.throws('select whoami()', 'permission denied', 'anon cannot call whoami');
rollback;
begin; :as_anon
select test.throws($$insert into projects (name) values ('x')$$, 'row-level security', 'anon cannot insert');
rollback;
begin; :as_stranger
select test.is((select count(*) from projects), 0::bigint, 'stranger sees no projects');
rollback;
begin; :as_stranger
select test.is(whoami(), null, 'stranger whoami is null');
rollback;

-- A member signed in with different capitals.
begin; reset role; set request.jwt.claims = '{"role": "authenticated", "email": "SAM@example.com"}'; set role authenticated;
select test.is((select count(*) from projects), 1::bigint, 'member sees projects (case-insensitive email)');
rollback;
begin; :as_adult
select test.is(test.try($$insert into contractors (name) values ('Pool Guy')$$), 'rows:1', 'member adds contractor');
rollback;
begin; :as_adult
select test.throws($$insert into members (email, name) values ('y@example.com', 'Y')$$, 'row-level security', 'member cannot add members');
rollback;
begin; :as_admin
select test.is(test.try($$insert into members (email, name) values ('spouse@example.com', 'S')$$), 'rows:1', 'admin adds member');
rollback;
begin; :as_admin
select test.is(test.try($$delete from members where email = 'alex@example.com'$$), 'rows:0', 'admin cannot delete self');
rollback;

-- The share page.
begin; :as_anon
select test.ok(get_shared_project('aaaaaaaaaaaaaaaaaaaaaaaa')::text like '%Pat Lee, Lee Electric%', 'share strips contact + private notes');
rollback;
begin; :as_anon
select test.is(get_shared_project('aaaaaaaaaaaaaaaaaaaaaaaa')::text like '%gate 1234%', false, 'share has no private notes');
rollback;
begin; :as_anon
select test.is(get_shared_project('aaaaaaaaaaaaaaaaaaaaaaaa')::text like '%1111%', false, 'share has no contractor id');
rollback;

-- The sign-up hook (run by the owner here, as Supabase Auth would).
begin; :as_owner
select test.is(hook_family_only_signup('{"user": {"email": "Alex@Example.com"}}'), '{}'::jsonb, 'hook allows listed email');
rollback;
begin; :as_owner
select test.ok(hook_family_only_signup('{"user": {"email": "x@evil.example"}}')::text like '%not on the family list%', 'hook blocks unlisted email');
rollback;

-- The email log.
begin; :as_adult
select test.is(test.try($$insert into email_log (recipients, subject) values ('{pat@lee.example}', 'Hi')$$), 'rows:1', 'member logs own email');
rollback;
begin; :as_adult
insert into email_log (recipients, subject) values ('{pat@lee.example}', 'Hi');
select test.is((select sent_by from email_log), 'sam@example.com', 'sent_by defaults to caller');
rollback;
begin; :as_adult
select test.throws($$insert into email_log (sent_by, recipients, subject) values ('alex@example.com', '{a@b.co}', 'Hi')$$,
                   'row-level security', 'member cannot log as someone else');
rollback;
begin; :as_stranger
select test.throws($$insert into email_log (recipients, subject) values ('{a@b.co}', 'Hi')$$, 'row-level security', 'stranger cannot log email');
rollback;
begin; :as_anon
select test.is((select count(*) from email_log), 0::bigint, 'anon cannot read email log');
rollback;
begin; :as_adult
select test.throws($$insert into email_log (recipients, subject) values ('{}', 'Hi')$$, 'violates check constraint', 'empty recipients rejected');
rollback;
begin; :as_adult
insert into email_log (recipients, subject) values ('{a@b.co}', 'Hi');
select test.is((select count(*) from email_log where created_at >= now() - interval '1 day'), 1::bigint, 'daily count query works for members');
rollback;

-- Hardening added after Supabase's security advisor review.
begin; :as_adult
select test.throws($$select get_shared_project('aaaaaaaaaaaaaaaaaaaaaaaa')$$, 'permission denied', 'signed-in cannot call share function');
rollback;
begin; :as_owner
select test.is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname in ('is_member', 'is_admin')), 0::bigint, 'membership helpers not in public schema');
rollback;
begin; :as_anon
select test.throws('select private.is_member()', 'permission denied', 'anon cannot call private.is_member');
rollback;
begin; :as_owner
select test.is((select prosecdef from pg_proc where proname = 'whoami'), false, 'whoami runs as invoker');
rollback;
begin; :as_adult
select test.is(whoami() ->> 'email', 'sam@example.com', 'member whoami still works');
rollback;
