-- A project's selections (migration 0024, docs/v1.4-project-guests.md §9): paint colors, door knobs, tile, by room, with
-- their status. Every family member, and a guest of that project, reads and changes them; approving or turning one
-- down is a parent's; anyone else who changes what an approved one is sends it back to Proposed. Riley
-- (riley@example.com) is the made-up designer on the Kitchen project; a Deck project isn't hers.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Jordan (removed). Everything is made up.
\ir roles.sql
\ir fixtures.sql
\set as_guest 'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "riley@example.com"}''; set role authenticated;'

:as_owner
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated;
create function pg_temp.sel(p_id uuid) returns text language sql stable security definer as $$
  select coalesce(room, '-') || ' · ' || item || ' · ' || coalesce(product, '-') || ' · ' || coalesce(finish, '-') || ' · ' || status
    || ' · ' || coalesce(updated_by, '-') from public.project_selections where id = p_id
$$;
grant execute on function pg_temp.sel(uuid) to anon, authenticated;
insert into projects (name, schedule) values ('Deck', '{"project": {"start": "2026-11-02"}, "trades": {}, "phases": []}');
:as_admin
select add_project_guest(test.project('Kitchen'), 'riley@example.com', 'Riley');

-- ---------------------------------------------------------------------
-- The schema and its grants
-- ---------------------------------------------------------------------
:as_owner
select test.is(hub_schema_version(), 24, 'hub_schema_version is 24');
select test.ok((select c.relrowsecurity from pg_class c where c.oid = 'public.project_selections'::regclass), 'project_selections has row-level security');
select test.ok(not has_table_privilege('anon', 'public.project_selections', 'select') and not has_table_privilege('service_role', 'public.project_selections', 'select')
               and has_table_privilege('authenticated', 'public.project_selections', 'select') and has_table_privilege('authenticated', 'public.project_selections', 'delete')
               and has_column_privilege('authenticated', 'public.project_selections', 'status', 'update')
               and not has_column_privilege('authenticated', 'public.project_selections', 'project_id', 'update')
               and not has_column_privilege('authenticated', 'public.project_selections', 'created_by', 'insert')
               and not has_column_privilege('authenticated', 'public.project_selections', 'updated_by', 'update'),
               'grants: anon and service_role nothing; signed-in users select, delete and the table''s own columns, never project_id on update or the audit columns');
select test.ok((select coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%' from pg_proc p where p.proname = 'selection_tidy'),
               'private.selection_tidy has set search_path');
select test.is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                and p.proname <> 'selection_tidy' and p.prosrc ~ '\mproject_selections\M'), 0,
               'no function reads selections (not an email, the wall, the board, Google, My day, a tutor link or the share link)');

-- ---------------------------------------------------------------------
-- The family: add, change, approve
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.run($$insert into project_selections (id, project_id, room, item, product, finish, url, price, quantity)
  values ('5e100000-0000-4000-8000-000000000001', test.project('Kitchen'), '  Kitchen ', ' Cabinet
 knobs ', 'Round knob 1-1/4 in', 'Satin brass', 'https://hardware.example/knob', 12.50, 24)$$), 'ok', 'Sam adds cabinet knobs');
select test.is(pg_temp.sel('5e100000-0000-4000-8000-000000000001'), 'Kitchen · Cabinet knobs · Round knob 1-1/4 in · Satin brass · proposed · sam@example.com',
               '... cleaned to one line, Proposed, written as Sam');
select test.is(pg_temp.run($$update project_selections set status = 'approved' where id = '5e100000-0000-4000-8000-000000000001'$$),
               '42501 Only a parent approves or turns down a selection.', 'an adult can''t approve');
select test.is(pg_temp.run($$insert into project_selections (project_id, item, status) values (test.project('Kitchen'), 'Sink', 'approved')$$),
               '42501 Only a parent approves or turns down a selection.', '... nor add one already approved');
:as_admin
select test.is(pg_temp.run($$update project_selections set status = 'approved' where id = '5e100000-0000-4000-8000-000000000001'$$), 'ok', 'Alex approves it');
select test.is(pg_temp.run($$insert into project_selections (id, project_id, room, item, finish) values
  ('5e100000-0000-4000-8000-000000000002', test.project('Kitchen'), 'Kitchen', 'Wall paint', 'Warm white')$$), 'ok', 'Alex adds wall paint');
select test.is(pg_temp.run($$update project_selections set finish = 'Soft white' where id = '5e100000-0000-4000-8000-000000000001'$$), 'ok', 'Alex changes an approved one');
select test.is(pg_temp.sel('5e100000-0000-4000-8000-000000000001'), 'Kitchen · Cabinet knobs · Round knob 1-1/4 in · Soft white · approved · alex@example.com',
               '... it stays approved (a parent''s change)');
select test.is(pg_temp.run($$update project_selections set finish = 'Satin brass' where id = '5e100000-0000-4000-8000-000000000001'$$), 'ok', 'and back');

-- The checks.
select test.is(pg_temp.run($$insert into project_selections (project_id, item) values (test.project('Kitchen'), '   ')$$),
               '23514 new row for relation "project_selections" violates check constraint "project_selections_item_check"', 'an empty item: refused');
select test.is(pg_temp.run($$insert into project_selections (project_id, item, url) values (test.project('Kitchen'), 'x', 'javascript:alert(1)')$$),
               '23514 new row for relation "project_selections" violates check constraint "project_selections_url_check"', 'a link that isn''t https: refused');
select test.is(pg_temp.run($$insert into project_selections (project_id, item, photo_url) values (test.project('Kitchen'), 'x', 'http://photo.example/a.jpg')$$),
               '23514 new row for relation "project_selections" violates check constraint "project_selections_photo_url_check"', 'a photo link that isn''t https: refused');
select test.is(pg_temp.run($$insert into project_selections (project_id, item, price) values (test.project('Kitchen'), 'x', -1)$$),
               '23514 new row for relation "project_selections" violates check constraint "project_selections_price_check"', 'a negative price: refused');
select test.is(pg_temp.run($$insert into project_selections (project_id, item, status) values (test.project('Kitchen'), 'x', 'maybe')$$),
               '23514 new row for relation "project_selections" violates check constraint "project_selections_status_check"', 'a status that isn''t on the list: refused');
select test.is(pg_temp.run($$insert into project_selections (project_id, item, created_by) values (test.project('Kitchen'), 'x', 'someone')$$),
               '42501 permission denied for table project_selections', 'nobody sets created_by');
select test.is(pg_temp.run($$update project_selections set project_id = test.project('Deck') where id = '5e100000-0000-4000-8000-000000000002'$$),
               '42501 permission denied for table project_selections', 'a selection can''t be moved to another project');

-- ---------------------------------------------------------------------
-- The project's guest
-- ---------------------------------------------------------------------
:as_guest
select test.is((select string_agg(item, ', ' order by item) from project_selections), 'Cabinet knobs, Wall paint', 'Riley sees the Kitchen''s selections');
select test.is(pg_temp.run($$insert into project_selections (id, project_id, room, item, product) values
  ('5e100000-0000-4000-8000-000000000003', test.project('Kitchen'), 'Kitchen', 'Faucet', 'Pull-down, brushed nickel')$$), 'ok', 'Riley proposes a faucet');
select test.is(pg_temp.sel('5e100000-0000-4000-8000-000000000003'), 'Kitchen · Faucet · Pull-down, brushed nickel · - · proposed · riley@example.com', '... Proposed, written as Riley');
select test.is(pg_temp.run($$update project_selections set status = 'approved' where id = '5e100000-0000-4000-8000-000000000003'$$),
               '42501 Only a parent approves or turns down a selection.', 'Riley can''t approve her own');
select test.is(pg_temp.run($$update project_selections set status = 'rejected' where id = '5e100000-0000-4000-8000-000000000002'$$),
               '42501 Only a parent approves or turns down a selection.', '... or turn one down');
select test.is(pg_temp.run($$update project_selections set status = 'ordered' where id = '5e100000-0000-4000-8000-000000000001'$$), 'ok', 'Riley marks the approved knobs ordered');
select test.is(pg_temp.run($$update project_selections set status = 'approved' where id = '5e100000-0000-4000-8000-000000000001'$$),
               '42501 Only a parent approves or turns down a selection.', '... and can''t put them back to approved');
:as_admin
select test.is(pg_temp.run($$update project_selections set status = 'approved' where id = '5e100000-0000-4000-8000-000000000001'$$), 'ok', 'Alex puts them back to approved');
:as_guest
select test.is(pg_temp.run($$update project_selections set note = 'Order 2 spare' where id = '5e100000-0000-4000-8000-000000000001'$$), 'ok', 'Riley adds a note to the approved knobs');
select test.is((select status from project_selections where id = '5e100000-0000-4000-8000-000000000001'), 'approved', '... a note keeps it approved');
select test.is(pg_temp.run($$update project_selections set finish = 'Matte black' where id = '5e100000-0000-4000-8000-000000000001'$$), 'ok', 'Riley changes the approved knobs'' finish');
select test.is(pg_temp.sel('5e100000-0000-4000-8000-000000000001'), 'Kitchen · Cabinet knobs · Round knob 1-1/4 in · Matte black · proposed · riley@example.com',
               '... and they go back to Proposed for a parent to approve again');
select test.is(pg_temp.run($$insert into project_selections (project_id, item) values (test.project('Deck'), 'Railing')$$),
               '42501 new row violates row-level security policy for table "project_selections"', 'Riley can''t add to a project that isn''t hers');
select test.is(pg_temp.run($$delete from project_selections where id = '5e100000-0000-4000-8000-000000000003'$$), 'ok', 'Riley deletes her faucet');
:as_owner
select test.is((select count(*)::int from project_selections where id = '5e100000-0000-4000-8000-000000000003'), 0, '... gone');
insert into project_selections (project_id, item) values (test.project('Deck'), 'Railing');
:as_guest
select test.is((select count(*)::int from project_selections where project_id = test.project('Deck')), 0, 'Riley never sees another project''s selections');

-- Taken off the project: she sees nothing.
:as_admin
select remove_project_guest(test.project('Kitchen'), 'riley@example.com');
:as_guest
select test.is((select count(*)::int from project_selections), 0, 'a guest taken off the project sees none of its selections');

-- Who else sees nothing.
:as_anon
select test.is(test.try('select * from public.project_selections'), 'denied', 'anon reads nothing');
:as_stranger
select test.is((select count(*)::int from project_selections), 0, 'a stranger reads nothing');
select test.is(pg_temp.run($$insert into project_selections (project_id, item) values (test.project('Kitchen'), 'x')$$),
               '42501 new row violates row-level security policy for table "project_selections"', '... and adds nothing');
:as_removed
select test.is((select count(*)::int from project_selections), 0, 'a removed parent reads nothing');

-- Gone with the project.
:as_owner
delete from projects where name = 'Deck';
select test.is((select count(*)::int from project_selections where item = 'Railing'), 0, 'a deleted project takes its selections with it');
