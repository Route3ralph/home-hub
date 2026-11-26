-- Birthdays (migration 0040, docs/v2-design.md §46): a list on the Family page, a 🎂 line on the Calendar and in the
-- morning email on the day, and a "Gift for …" heads-up from 7 days before, with a Bought tick that a parent sets.
-- Every member reads the list; only an admin adds, changes or deletes; the gift ticks are read only through the
-- functions, never by the person whose birthday it is. Grants, checks, 29 February, and that 0039's email is unchanged
-- when no birthday is near.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid), Morgan (a helper, Spanish), Jordan
-- (removed). Everything is made up.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-26 10:00 America/Chicago';
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
-- "name day turns" for each row of birthdays_between, in order.
create function pg_temp.days(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg((x ->> 'name') || ' ' || (x ->> 'day') || coalesce(' ' || (x ->> 'turns'), ''), ' | ' order by n), '-')
  from jsonb_array_elements(j) with ordinality t (x, n)
$$;
-- "name birthday turns bought" for each gift.
create function pg_temp.gifts(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg((x ->> 'name') || ' ' || (x ->> 'birthday') || coalesce(' ' || (x ->> 'turns'), '') || ' ' || (x ->> 'bought'), ' | ' order by n), '-')
  from jsonb_array_elements(j) with ordinality t (x, n)
$$;
-- "title · detail" for each item of a digest list.
create function pg_temp.items(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg((x ->> 'title') || coalesce(' · ' || (x ->> 'detail'), ''), ' | ' order by n), '-')
  from jsonb_array_elements(j) with ordinality t (x, n)
$$;
grant execute on function pg_temp.days(jsonb), pg_temp.gifts(jsonb), pg_temp.items(jsonb) to anon, authenticated, service_role;
create function pg_temp.bid(p_name text) returns uuid language sql stable security definer as $$
  select id from public.birthdays where name = p_name
$$;
grant execute on function pg_temp.bid(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- The schema, the signatures, their grants and row-level security
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 40, 'hub_schema_version is 40');
select test.ok((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.birthdays'::regclass, 'public.birthday_gifts'::regclass)),
               'birthdays and birthday_gifts have row-level security');
select test.ok(has_function_privilege('authenticated', 'public.birthdays_between(date, date)', 'execute')
               and has_function_privilege('authenticated', 'public.gift_heads_up(date)', 'execute')
               and has_function_privilege('authenticated', 'public.set_birthday_gift(uuid, integer, boolean)', 'execute')
               and not has_function_privilege('anon', 'public.birthdays_between(date, date)', 'execute')
               and not has_function_privilege('anon', 'public.gift_heads_up(date)', 'execute')
               and not has_function_privilege('anon', 'public.set_birthday_gift(uuid, integer, boolean)', 'execute')
               and not has_function_privilege('service_role', 'public.set_birthday_gift(uuid, integer, boolean)', 'execute'),
               'the three page functions: signed in only, never anon or service_role');
select test.ok(has_function_privilege('service_role', 'public.digest_for(uuid, date)', 'execute')
               and not has_function_privilege('authenticated', 'public.digest_for(uuid, date)', 'execute')
               and not has_function_privilege('anon', 'public.digest_for(uuid, date)', 'execute')
               and not has_function_privilege('authenticated', 'private.digest_for_v39(uuid, date)', 'execute'),
               'digest_for (the wrapper) and its 0039 body: service_role only, as before');
select test.ok(not has_function_privilege('authenticated', 'private.gifts_for(date, uuid)', 'execute')
               and not has_function_privilege('anon', 'private.gifts_for(date, uuid)', 'execute')
               and not has_function_privilege('authenticated', 'private.birthday_tidy()', 'execute'),
               'private.gifts_for and birthday_tidy: not for the pages');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%') from pg_proc p
                where p.proname in ('birthdays_between', 'gift_heads_up', 'set_birthday_gift', 'gifts_for', 'birthday_on',
                                    'birthday_word', 'birthday_tidy', 'digest_for', 'digest_for_v39')),
               '... each with set search_path');
select test.ok(not has_table_privilege('anon', 'public.birthdays', 'select') and has_table_privilege('service_role', 'public.birthdays', 'select')
               and not has_table_privilege('service_role', 'public.birthdays', 'insert')
               and has_table_privilege('authenticated', 'public.birthdays', 'select') and has_table_privilege('authenticated', 'public.birthdays', 'delete')
               and not has_column_privilege('authenticated', 'public.birthdays', 'created_by', 'insert')
               and not has_column_privilege('authenticated', 'public.birthdays', 'updated_by', 'update')
               and has_column_privilege('authenticated', 'public.birthdays', 'born_year', 'update'),
               'birthdays grants: anon nothing; service_role reads (the email); members select, delete and the list''s own columns, never the audit columns');
select test.ok(not has_table_privilege('authenticated', 'public.birthday_gifts', 'select') and not has_table_privilege('anon', 'public.birthday_gifts', 'select')
               and not has_table_privilege('authenticated', 'public.birthday_gifts', 'insert'),
               'birthday_gifts: no grants at all (only the functions read and write it)');

-- An empty list: every email exactly 0039's.
:as_service
select test.is((select count(*) from public.people p where public.digest_for(p.id, '2026-11-26') is distinct from private.digest_for_v39(p.id, '2026-11-26')),
               0::bigint, 'with no birthdays, every person''s email is exactly 0039''s');

-- ---------------------------------------------------------------------
-- The list: an admin adds; a member reads; nobody else
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.run($$insert into birthdays (name, month, day, born_year, person_id) values
  ('  Taylor
 ', 12, 1, 2014, test.person('Taylor')),
  ('Sam', 11, 30, null, test.person('Sam')),
  ('Alex', 12, 3, 1980, test.person('Alex')),
  ('Grandma Pat', 2, 29, 1952, null)$$), 'ok', 'Alex adds four birthdays');
select test.is((select name || ' · ' || created_by from birthdays where person_id = test.person('Taylor')), 'Taylor · alex@example.com',
               '... cleaned to one line, written as Alex');
select test.is(pg_temp.run($$insert into birthdays (name, month, day) values ('Nobody', 2, 30)$$) like '23514%', true, '30 February is refused');
select test.is(pg_temp.run($$insert into birthdays (name, month, day) values ('Nobody', 4, 31)$$) like '23514%', true, '31 April is refused');
select test.is(pg_temp.run($$insert into birthdays (name, month, day, born_year) values ('Nobody', 2, 29, 1951)$$) like '23514%', true,
               '29 February in a year that had none is refused');
select test.is(pg_temp.run($$insert into birthdays (name, month, day) values ('', 5, 5)$$) like '23514%', true, 'a name is needed');
select test.is(pg_temp.run($$insert into birthdays (name, month, day, person_id) values ('Taylor again', 6, 6, test.person('Taylor'))$$) like '23505%', true,
               'one birthday per person on the family list');
select test.is(pg_temp.run($$update birthdays set born_year = 2015 where name = 'Taylor'$$), 'ok', 'Alex changes a year');
select test.is(pg_temp.run($$update birthdays set born_year = 2014 where name = 'Taylor'$$), 'ok', '... and back');
select test.is(pg_temp.run($$update birthdays set created_by = 'x' where name = 'Taylor'$$) like '42501%', true, '... never the audit columns');

:as_adult
select test.is((select count(*) from birthdays), 4::bigint, 'Sam (an adult member) reads the list');
select test.is(test.try($$insert into birthdays (name, month, day) values ('Sam''s friend', 1, 1)$$), 'denied', '... but can''t add to it');
select test.is(test.try($$update birthdays set day = 2 where name = 'Grandma Pat'$$), 'rows:0', '... or change it');
select test.is(test.try($$delete from birthdays where name = 'Grandma Pat'$$), 'rows:0', '... or delete from it');
:as_removed
select test.is((select count(*) from birthdays), 0::bigint, 'Jordan (removed) sees none');
:as_stranger
select test.is((select count(*) from birthdays), 0::bigint, 'a stranger sees none');
:as_anon
select test.is(test.try($$select * from birthdays$$), 'denied', 'anon can''t read the table');

-- ---------------------------------------------------------------------
-- birthdays_between: the Calendar's days
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.days(birthdays_between('2026-11-26', '2026-12-31')),
               'Sam 2026-11-30 | Taylor 2026-12-01 12 | Alex 2026-12-03 46', 'the next five weeks: in order, with the age when the year is known');
select test.is(pg_temp.days(birthdays_between('2027-02-01', '2027-03-01')), 'Grandma Pat 2027-02-28 75', '29 February is on the 28th in 2027');
select test.is(pg_temp.days(birthdays_between('2028-02-28', '2028-03-01')), 'Grandma Pat 2028-02-29 76', '... and on the 29th in 2028');
select test.is(pg_temp.days(birthdays_between('2026-12-20', '2027-01-10')), '-', 'none over the new year here');
select test.is(pg_temp.days(birthdays_between('2026-11-30', '2027-12-01')),
               'Sam 2026-11-30 | Taylor 2026-12-01 12 | Alex 2026-12-03 46 | Grandma Pat 2027-02-28 75 | Sam 2027-11-30 | Taylor 2027-12-01 13',
               'a span across two years lists each year''s');
select test.is(pg_temp.run($$select birthdays_between('2026-01-01', '2027-03-01')$$) like '22023%', true, 'more than 400 days is refused');
select test.is(pg_temp.run($$select birthdays_between('2026-12-01', '2026-11-01')$$) like '22023%', true, '... and so is a range that runs backwards');
:as_stranger
select test.is(birthdays_between('2026-11-26', '2026-12-31'), '[]'::jsonb, 'a stranger gets none');

-- ---------------------------------------------------------------------
-- gift_heads_up and Bought
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.gifts(gift_heads_up('2026-11-26')), 'Sam 2026-11-30 false | Taylor 2026-12-01 12 false',
               'Alex''s gifts on Nov 26: Sam and Taylor within 7 days, never Alex''s own (Dec 3)');
select test.is(pg_temp.gifts(gift_heads_up('2026-11-22')), '-', 'Nov 22: nothing yet (8 days before Sam''s)');
select test.is(pg_temp.gifts(gift_heads_up('2026-11-23')), 'Sam 2026-11-30 false', 'Nov 23: Sam''s, 7 days ahead');
select test.is(pg_temp.gifts(gift_heads_up('2026-12-01')), 'Taylor 2026-12-01 12 false', 'Dec 1: Taylor''s on the day itself, Sam''s gone');
select test.is(pg_temp.run($$select set_birthday_gift(pg_temp.bid('Taylor'), 2026, true)$$), 'ok', 'Alex ticks Taylor''s Bought');
select test.is(pg_temp.run($$select set_birthday_gift(pg_temp.bid('Taylor'), 2026, true)$$), 'ok', '... twice is fine');
select test.is(pg_temp.gifts(gift_heads_up('2026-11-26')), 'Sam 2026-11-30 false | Taylor 2026-12-01 12 true', '... and it reads bought');
select test.is(pg_temp.run($$select set_birthday_gift(pg_temp.bid('Alex'), 2026, true)$$) like '42501%', true, 'Alex can''t tick his own');
select test.is(pg_temp.run($$select set_birthday_gift(pg_temp.bid('Sam'), 2030, true)$$) like '22023%', true, 'a year far off is refused');
select test.is(pg_temp.run($$select set_birthday_gift('00000000-0000-4000-8000-000000000000', 2026, true)$$) like '22023%', true, 'an unknown birthday is refused');
:as_adult
select test.is(gift_heads_up('2026-11-26'), '[]'::jsonb, 'Sam (an adult, not an admin) gets no gifts');
select test.is(pg_temp.run($$select set_birthday_gift(pg_temp.bid('Taylor'), 2026, false)$$) like '42501%', true, '... and can''t untick one');
:as_stranger
select test.is(gift_heads_up('2026-11-26'), '[]'::jsonb, 'a stranger gets none');
:as_admin
select test.is(pg_temp.run($$select set_birthday_gift(pg_temp.bid('Taylor'), 2026, false)$$), 'ok', 'Alex unticks it');
select test.is(pg_temp.gifts(gift_heads_up('2026-11-26')), 'Sam 2026-11-30 false | Taylor 2026-12-01 12 false', '... not bought again');
select test.is(pg_temp.run($$select set_birthday_gift(pg_temp.bid('Taylor'), 2026, true)$$), 'ok', 'and ticks it again for the emails below');

-- ---------------------------------------------------------------------
-- The morning email
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.items(digest_for(test.person('Alex'), '2026-11-26') -> 'heads_up')
                 like '%🎁 Gift for Sam · birthday Mon Nov 30%', true, 'Alex''s email on Nov 26: Gift for Sam in Heads-up');
select test.is(pg_temp.items(digest_for(test.person('Alex'), '2026-11-26') -> 'heads_up') like '%Taylor%', false, '... not Taylor''s (bought)');
select test.is(pg_temp.items(digest_for(test.person('Alex'), '2026-11-29') -> 'heads_up') like '%Alex%', false, '... and never his own');
select test.is(pg_temp.items(digest_for(test.person('Sam'), '2026-11-26') -> 'heads_up') like '%Gift%', false, 'Sam (an adult) gets no gifts');
select test.is(pg_temp.items(digest_for(test.person('Morgan'), '2026-11-26') -> 'heads_up') like '%Regalo%', false, 'Morgan (a helper) gets none');
select test.is(digest_for(test.person('Jordan'), '2026-11-26') -> 'heads_up' @> '[{"kind": "gift", "title": "🎁 Gift for Sam"}]', true,
               'Jordan (a parent on the list) gets the gift');
select test.is((digest_for(test.person('Alex'), '2026-11-26') -> 'empty')::text, 'false', 'a day with a gift isn''t empty');

select test.is(pg_temp.items(digest_for(test.person('Alex'), '2026-12-01') -> 'today') like '🎂 Taylor turns 12 · %' or
               (digest_for(test.person('Alex'), '2026-12-01') -> 'today' -> 0 ->> 'title') = '🎂 Taylor turns 12', true,
               'Alex''s email on Dec 1: "🎂 Taylor turns 12" first in Today');
select test.is(digest_for(test.person('Alex'), '2026-12-01') -> 'today' -> 0 ->> 'time', 'All day', '... all day');
select test.is(digest_for(test.person('Morgan'), '2026-12-01') -> 'today' -> 0 ->> 'title', '🎂 Taylor cumple 12', 'Morgan''s, in Spanish');
select test.is(digest_for(test.person('Morgan'), '2026-12-01') -> 'today' -> 0 ->> 'time', 'Todo el día', '... todo el día');
select test.is(pg_temp.items(digest_for(test.person('Taylor'), '2026-12-01') -> 'today') like '%🎂%', false, 'Taylor''s own email has no line about himself');
select test.is(digest_for(test.person('Alex'), '2026-11-30') -> 'today' -> 0 ->> 'title', '🎂 Sam''s birthday', 'no year: "Sam''s birthday"');
select test.is(digest_for(test.person('Alex'), '2027-02-28') -> 'today' -> 0 ->> 'title', '🎂 Grandma Pat turns 75', '29 February on the 28th in 2027');
select test.is((select count(*) from public.people p where public.digest_for(p.id, '2026-06-15') is distinct from private.digest_for_v39(p.id, '2026-06-15')),
               0::bigint, 'June 15, no birthday near: every email exactly 0039''s');
select test.is(digest_for(test.person('Alex'), '2026-11-26') - 'heads_up' - 'empty' - 'subject' - 'today',
               private.digest_for_v39(test.person('Alex'), '2026-11-26') - 'heads_up' - 'empty' - 'subject' - 'today',
               'apart from Today, Heads-up, the subject and empty, Alex''s email is 0039''s');

-- ---------------------------------------------------------------------
-- Deleting
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.run($$delete from birthdays where name = 'Taylor'$$), 'ok', 'Alex deletes Taylor''s birthday');
:as_owner
select test.is((select count(*) from birthday_gifts), 0::bigint, '... and its Bought tick goes with it');
update birthdays set person_id = test.person('Morgan') where name = 'Grandma Pat';
delete from people where name = 'Morgan';
select test.is((select count(*)::text || ' ' || coalesce((select person_id::text from birthdays where name = 'Grandma Pat'), 'null') from birthdays), '3 null',
               'deleting a person keeps their birthday, with person_id cleared');
