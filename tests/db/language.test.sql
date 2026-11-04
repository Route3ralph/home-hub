-- My day's language switch (migration 0014, docs/v2-design.md §19): set_language_by_token(p_token, p_lang) sets the
-- language of the person whose My day token it is, 'en' or 'es' only, and answers get_person_day(p_token) in it.
-- An unknown, malformed or replaced token, or a person who isn't active: null, nothing changed. A tutor link's token
-- or a confirmation secret never works. A change is one of the link's My day changes (30 a day); asking for the
-- language it already has changes and counts nothing. Anon and signed-in callers may call it; service_role may not.
-- The household is fixtures.sql's: Taylor (kid, English), Morgan (helper, Spanish).
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';
select test.is(hub_schema_version(), 17, 'hub_schema_version is 17 (0014 made it 14, 0015 15, 0016 16, 0017 makes it 17)');
-- Runs a statement and keeps what it did: 'ok', or the error's code and message.
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
create function pg_temp.lang(p_name text) returns text language sql stable security definer as $$
  select language from public.people where name = p_name
$$;
create function pg_temp.langs() returns text language sql stable security definer as $$
  select string_agg(name || ':' || language, ' ' order by name) from public.people
$$;
create function pg_temp.used(p_name text) returns text language sql stable security definer as $$
  select coalesce((select u.changes || ' ' || u.ticks from public.my_day_use u
                   where u.person_id = (select id from public.people where name = p_name) and u.day = public.today_local()), 'none')
$$;
-- A tutor link for Taylor (homework on), and Morgan's confirmation secret.
insert into homework_kids (kid_id) values (test.person('Taylor'));
insert into tutor_links (kid_id, label, expires_on) values (test.person('Taylor'), 'Pat Lee, tutor', '2027-05-01');
create function pg_temp.tutor() returns text language sql stable security definer as $$
  select token from public.tutor_links where label = 'Pat Lee, tutor'
$$;
insert into people_confirm (person_id) values (test.person('Morgan')) on conflict do nothing;
select test.ok(pg_temp.tutor() ~ '^[0-9a-f]{32}$' and test.confirm_token('Morgan') ~ '^[0-9a-f]{32}$', 'a tutor link and a confirmation secret to try');
select pg_temp.langs() as before \gset

-- ---------------------------------------------------------------------
-- The function itself
-- ---------------------------------------------------------------------
select test.is((select prosecdef from pg_proc where oid = 'public.set_language_by_token(text, text)'::regprocedure), true, 'set_language_by_token is security definer');
select test.ok((select proconfig from pg_proc where oid = 'public.set_language_by_token(text, text)'::regprocedure) @> '{"search_path=\"\""}', '... with search_path = ''''');
select test.is((select pg_get_function_result(oid) from pg_proc where oid = 'public.set_language_by_token(text, text)'::regprocedure), 'jsonb', '... and returns jsonb');
select test.is(has_function_privilege('anon', 'public.set_language_by_token(text, text)', 'execute'), true, 'anon may call it');
select test.is(has_function_privilege('authenticated', 'public.set_language_by_token(text, text)', 'execute'), true, 'authenticated may call it');
select test.is(has_function_privilege('service_role', 'public.set_language_by_token(text, text)', 'execute'), false, 'service_role may not');
select test.is((select count(*) from information_schema.routine_privileges where specific_schema = 'public' and routine_name = 'set_language_by_token' and grantee = 'PUBLIC'),
               0::bigint, 'public may not (revoked)');

-- ---------------------------------------------------------------------
-- English to Spanish and back, only that person
-- ---------------------------------------------------------------------
:as_anon
select test.is((select set_language_by_token(test.token('Taylor'), 'es') -> 'person' ->> 'language'), 'es',
               'Taylor''s link: es, answered with get_person_day in Spanish');
:as_owner
select test.is(pg_temp.lang('Taylor'), 'es', '... Taylor''s people.language is es');
select test.is(pg_temp.langs(), replace(:'before', 'Taylor:en', 'Taylor:es'), '... and nobody else''s changed');
select test.is(pg_temp.used('Taylor'), '1 0', '... one My day change counted');
:as_anon
select test.is(set_language_by_token(test.token('Taylor'), 'es') = get_person_day(test.token('Taylor')), true,
               'the answer is get_person_day(p_token)''s');
:as_owner
select test.is(pg_temp.used('Taylor'), '1 0', '... asking for the language it already has counts nothing');
:as_anon
select test.is((select set_language_by_token(test.token('Taylor'), 'en') -> 'person' ->> 'language'), 'en', 'and back to en');
:as_owner
select test.is(pg_temp.langs(), :'before', '... everyone as before');
select test.is(pg_temp.used('Taylor'), '2 0', '... a second change counted');
:as_anon
select test.is((select set_language_by_token(test.token('Morgan'), 'en') -> 'person' ->> 'language'), 'en', 'Morgan''s link: Spanish to English');
select test.is((select set_language_by_token(test.token('Morgan'), 'es') -> 'person' ->> 'language'), 'es', '... and back');
:as_owner
select test.is(pg_temp.langs(), :'before', '... everyone as before');
-- A signed-in member's phone with the link open works the same (the token is the key, not the sign-in).
:as_adult
select test.is((select set_language_by_token(test.token('Taylor'), 'es') -> 'person' ->> 'language'), 'es', 'signed in: the token is the key');
:as_owner
update people set language = 'en' where name = 'Taylor';

-- ---------------------------------------------------------------------
-- Refused
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.run($$select set_language_by_token(test.token('Taylor'), 'fr')$$), '22023 Choose English or Español.', 'fr: 22023 "Choose English or Español."');
select test.is(pg_temp.run($$select set_language_by_token(test.token('Taylor'), 'ES')$$), '22023 Choose English or Español.', 'ES (not lower case): 22023');
select test.is(pg_temp.run($$select set_language_by_token(test.token('Taylor'), '')$$), '22023 Choose English or Español.', 'empty: 22023');
select test.is(pg_temp.run($$select set_language_by_token(test.token('Taylor'), null)$$), '22023 Choose English or Español.', 'null: 22023');
select test.is(set_language_by_token(repeat('0', 32), 'es'), null, 'an unknown token: null');
select test.is(set_language_by_token('not-a-token', 'es'), null, 'a malformed token: null');
select test.is(set_language_by_token(null, 'es'), null, 'no token: null');
select test.is(set_language_by_token(upper(test.token('Taylor')), 'es'), null, 'the token in capitals: null');
select test.is(set_language_by_token(repeat('0', 32), 'fr'), null, 'an unknown token with a bad language: null (the token first)');
select test.is(set_language_by_token(pg_temp.tutor(), 'es'), null, 'a tutor link''s token never works: null');
select test.is(set_language_by_token(test.confirm_token('Morgan'), 'en'), null, 'a confirmation secret never works: null');
:as_owner
select test.is(pg_temp.langs(), :'before', '... none of them changed anyone');
-- A replaced token, and a person who isn't active.
select test.token('Taylor') as old_token \gset
update people set day_token = encode(extensions.gen_random_bytes(16), 'hex') where name = 'Taylor';
:as_anon
select test.is(set_language_by_token(:'old_token', 'es'), null, 'a replaced token: null');
select test.ok(set_language_by_token(test.token('Taylor'), 'en') is not null, '... the new one works');
:as_owner
update people set active = false where name = 'Morgan';
:as_anon
select test.is(set_language_by_token(test.token('Morgan'), 'en'), null, 'a person who isn''t active: null');
:as_owner
select test.is(pg_temp.lang('Morgan'), 'es', '... and their language is kept');
update people set active = true where name = 'Morgan';
select test.is(pg_temp.langs(), :'before', 'everyone as before');

-- ---------------------------------------------------------------------
-- The My day limiter (30 changes a day, shared with the link's other changes)
-- ---------------------------------------------------------------------
update my_day_use set changes = 30 where person_id = test.person('Taylor') and day = public.today_local();
:as_anon
select test.is(pg_temp.run($$select set_language_by_token(test.token('Taylor'), 'es')$$), 'P0001 Too many changes from My day today.',
               'at the cap: P0001 "Too many changes from My day today."');
select test.ok(set_language_by_token(test.token('Taylor'), 'en') is not null, '... while asking for the language it has still answers');
:as_owner
select test.is(pg_temp.lang('Taylor') || ' ' || pg_temp.used('Taylor'), 'en 30 0', '... nothing changed, nothing more counted');

-- service_role (hub-jobs) may not call it.
:as_service
select test.is(left(pg_temp.run($$select public.set_language_by_token(test.token('Taylor'), 'es')$$), 5), '42501', 'service_role: denied');
:as_owner
select test.is(pg_temp.lang('Taylor'), 'en', '... and nothing changed');
