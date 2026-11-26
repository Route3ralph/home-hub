-- The gift switch (migration 0041, docs/v2-design.md §47): birthdays.gift, "Remind me to buy a gift", true for every
-- birthday. Off, the birthday still shows on its day (birthdays_between, the morning email's Today) but never as a gift
-- (gift_heads_up, the email's Heads-up). A parent sets it (a column grant); Sam can't. Everything is made up.
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

select test.is(hub_schema_version(), 41, 'hub_schema_version is 41');
select test.is((select column_default || ' ' || is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'birthdays' and column_name = 'gift'),
               'true NO', 'birthdays.gift: not null, true by default');
select test.ok(has_column_privilege('authenticated', 'public.birthdays', 'gift', 'insert') and has_column_privilege('authenticated', 'public.birthdays', 'gift', 'update'),
               '... signed-in users may write it (RLS keeps it to admins)');
select test.ok(not has_function_privilege('authenticated', 'private.gifts_for(date, uuid)', 'execute') and has_function_privilege('service_role', 'private.gifts_for(date, uuid)', 'execute')
               and (select coalesce(array_to_string(proconfig, ','), '') like '%search_path=%' from pg_proc where oid = 'private.gifts_for(date, uuid)'::regprocedure),
               'private.gifts_for keeps 0040''s grants and its empty search_path');

:as_admin
select test.is(pg_temp.run($$insert into birthdays (name, month, day, born_year) values ('Grandma Pat', 11, 30, 1952), ('Cousin Robin', 12, 1, 2015)$$), 'ok',
               'Alex adds two birthdays, each with its gift reminder on');
select test.is((select string_agg(name || ' ' || gift, ', ' order by name) from birthdays), 'Cousin Robin true, Grandma Pat true', '... gift true by default');
select test.is((select string_agg(x ->> 'name', ', ' order by x ->> 'name') from jsonb_array_elements(gift_heads_up('2026-11-26')) x), 'Cousin Robin, Grandma Pat',
               'both are gifts due on Nov 26');
select test.is(pg_temp.run($$update birthdays set gift = false where name = 'Cousin Robin'$$), 'ok', 'Alex turns Cousin Robin''s reminder off');
select test.is((select string_agg(x ->> 'name', ', ') from jsonb_array_elements(gift_heads_up('2026-11-26')) x), 'Grandma Pat', '... and only Grandma Pat''s gift is due');
select test.is((select string_agg(x ->> 'name', ', ' order by x ->> 'day') from jsonb_array_elements(birthdays_between('2026-11-26', '2026-12-31')) x), 'Grandma Pat, Cousin Robin',
               '... both still on the Calendar');
:as_adult
select test.is(test.try($$update birthdays set gift = true where name = 'Cousin Robin'$$), 'rows:0', 'Sam (not an admin) can''t turn it back on');

:as_service
select test.is((select string_agg(x ->> 'title', ' | ') from jsonb_array_elements(digest_for(test.person('Alex'), '2026-11-26') -> 'heads_up') x where x ->> 'kind' = 'gift'),
               '🎁 Gift for Grandma Pat', 'Alex''s email: the gift for Grandma Pat only');
select test.is(digest_for(test.person('Alex'), '2026-12-01') -> 'today' -> 0 ->> 'title', '🎂 Cousin Robin turns 11',
               '... and on Dec 1 Cousin Robin''s birthday still leads Today');
