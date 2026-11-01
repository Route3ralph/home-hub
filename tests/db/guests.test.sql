-- Project guests (migration 0011, docs/v1.4-project-guests.md): a designer who signs in with a code, is not a member,
-- and sees and manages only the projects a parent assigns them. Riley (riley@example.com) is the made-up designer;
-- Quinn (quinn@example.com) a second guest. The Kitchen project (v1_data.sql) links Pat Lee to its electrician;
-- below, its plumber links City Water (an account with an account number), and a Deck project is not Riley's.
\ir roles.sql
\ir fixtures.sql
\set as_guest  'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "riley@example.com"}''; set role authenticated;'
\set as_guest2 'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "quinn@example.com"}''; set role authenticated;'

:as_owner
insert into projects (name, schedule) values ('Deck', '{"project": {"start": "2026-11-02"}, "trades": {}, "phases": []}');
update projects set schedule = jsonb_set(schedule, '{trades,plumber}',
                                         jsonb_build_object('name', 'Plumber', 'contractor_id', test.contractor('City Water')))
where name = 'Kitchen';

-- ---------------------------------------------------------------------
-- The schema version and the catalog
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 11, 'hub_schema_version is 11 (0011 makes it 11)');
select test.is((select string_agg(c.relname || ':' || c.relrowsecurity, ', ' order by c.relname) from pg_class c
                where c.oid in ('public.guests'::regclass, 'public.project_guests'::regclass, 'public.project_contacts'::regclass)),
               'guests:true, project_contacts:true, project_guests:true', 'the three new tables have row-level security');
select test.is((select string_agg(t || ':' || r, ', ' order by t, r)
                from unnest(array['guests', 'project_guests', 'project_contacts']) t
                cross join unnest(array['anon', 'authenticated']) r
                where has_table_privilege(r, 'public.' || t, 'insert, update, delete, truncate, references, trigger')
                   or has_any_column_privilege(r, 'public.' || t, 'insert, update, references')
                   or (r = 'anon' and has_table_privilege(r, 'public.' || t, 'select'))),
               null, 'anon has no privilege on the new tables; signed-in users may only select them (row-level security decides)');
select test.is((select string_agg(p.proname || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' '
                       || (select string_agg(r || ':' || has_function_privilege(r, p.oid, 'execute'), ' ' order by r)
                           from unnest(array['anon', 'authenticated', 'service_role']) r), ' | ' order by p.proname)
                from pg_proc p where p.pronamespace = 'public'::regnamespace
                  and p.proname in ('guest_whoami', 'guest_contacts', 'guest_save_contact', 'add_project_guest', 'remove_project_guest', 'remove_guest')),
               'add_project_guest true v anon:false authenticated:true service_role:false | '
               'guest_contacts true s anon:false authenticated:true service_role:false | '
               'guest_save_contact true v anon:false authenticated:true service_role:false | '
               'guest_whoami true s anon:false authenticated:true service_role:false | '
               'remove_guest true v anon:false authenticated:true service_role:false | '
               'remove_project_guest true v anon:false authenticated:true service_role:false',
               'the six new public functions: definers that check the caller; signed-in users only');
select test.is((select string_agg(p.proname || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' '
                       || (select string_agg(r || ':' || has_function_privilege(r, p.oid, 'execute'), ' ' order by r)
                           from unnest(array['anon', 'authenticated']) r), ' | ' order by p.proname)
                from pg_proc p where p.pronamespace = 'private'::regnamespace
                  and p.proname in ('is_guest_of', 'schedule_contractors', 'guest_contact_ids', 'projects_guest_guard')),
               'guest_contact_ids true s anon:false authenticated:false | is_guest_of true s anon:false authenticated:true | '
               'projects_guest_guard true v anon:false authenticated:false | schedule_contractors false i anon:false authenticated:true',
               'the private helpers: is_guest_of for the policies; guest_contact_ids and the guard run as the owner and nobody may call them');
select test.ok((select pg_get_constraintdef(c.oid) from pg_constraint c
                where c.conrelid = 'public.projects'::regclass and pg_get_constraintdef(c.oid) like '%documents_url%') like '%https://drive%google%com/%',
               'projects.documents_url: a Google Drive address only');

-- ---------------------------------------------------------------------
-- Assigning (the parents only)
-- ---------------------------------------------------------------------
:as_adult
select test.throws($$select add_project_guest(test.project('Kitchen'), 'riley@example.com', 'Riley')$$,
                   'Only a parent can give someone access to a project.', 'an adult can''t add a guest');
:as_stranger
select test.throws($$select add_project_guest(test.project('Kitchen'), 'riley@example.com', 'Riley')$$,
                   'Only a parent can give someone access to a project.', 'a stranger can''t add a guest');
:as_admin
select test.throws($$select add_project_guest(test.project('Kitchen'), 'riley@example.com', null)$$,
                   'Type the guest''s name.', 'a new guest needs a name');
select test.throws($$select add_project_guest(test.project('Kitchen'), 'riley', 'Riley')$$,
                   'Type the guest''s email address.', 'a guest needs an email address');
select test.throws($$select add_project_guest(test.project('Kitchen'), 'Sam@Example.com', 'Sam')$$,
                   'sam@example.com already signs in as family, so they see every project.', 'a member can''t be a guest');
select test.throws($$select add_project_guest(gen_random_uuid(), 'riley@example.com', 'Riley')$$,
                   'That project isn''t there any more.', 'a project that isn''t there');
select test.is(add_project_guest(test.project('Kitchen'), '  Riley@Example.com ', 'Riley'),
               jsonb_build_object('email', 'riley@example.com', 'name', 'Riley', 'project_id', test.project('Kitchen')),
               'a parent gives Riley the Kitchen (the address lower-cased and trimmed)');
select test.is(add_project_guest(test.project('Kitchen'), 'riley@example.com', null),
               jsonb_build_object('email', 'riley@example.com', 'name', 'Riley', 'project_id', test.project('Kitchen')),
               '... again: nothing changes (no name needed for a guest already there)');
select test.is((select count(*) from project_guests where guest_email = 'riley@example.com'), 1::bigint, '... one link');
select test.is(add_project_guest(test.project('Deck'), 'quinn@example.com', 'Quinn') ->> 'name', 'Quinn', 'Quinn gets the Deck');
select test.is((select string_agg(email || ':' || name || ':' || created_by, ', ' order by email) from guests),
               'quinn@example.com:Quinn:alex@example.com, riley@example.com:Riley:alex@example.com', 'a parent sees the guests, and who added them');
select test.is((select count(*) from project_guests), 2::bigint, 'a parent sees who sees each project');
:as_adult
select test.is((select count(*) from guests) + (select count(*) from project_guests), 0::bigint, 'an adult sees no guests (the parents only)');

-- ---------------------------------------------------------------------
-- Signing in: the hook and guest_whoami
-- ---------------------------------------------------------------------
:as_owner
select test.is(hook_family_only_signup('{"user": {"email": "Riley@example.com"}}'), '{}'::jsonb, 'the sign-up hook lets a guest''s address make a login');
select test.is(hook_family_only_signup('{"user": {"email": "alex@example.com"}}'), '{}'::jsonb, '... and a member''s, as before');
select test.is(hook_family_only_signup('{"user": {"email": "casey@example.com"}}') -> 'error' ->> 'message', 'This email is not on the family list.',
               '... and still turns down anyone else');
:as_guest
select test.is(whoami(), null, 'a guest: whoami is null (send-email and hub-jobs treat them as not family)');
select test.is(guest_whoami(), jsonb_build_object('email', 'riley@example.com', 'name', 'Riley', 'projects', jsonb_build_array(test.project('Kitchen'))),
               'guest_whoami: Riley, with the Kitchen');
select test.is(mark_signed_in()::text, '', 'mark_signed_in does nothing for a guest');
:as_admin
select test.is(guest_whoami(), null, 'guest_whoami is null for a member');
:as_stranger
select test.is(guest_whoami(), null, 'guest_whoami is null for anyone not a guest');
:as_anon
select test.is(test.can($$select guest_whoami()$$), 'denied', 'anon can''t call guest_whoami');

-- ---------------------------------------------------------------------
-- What a guest sees: their projects, nothing else
-- ---------------------------------------------------------------------
:as_guest
select test.is((select string_agg(name, ', ') from projects), 'Kitchen', 'a guest sees only the projects assigned to them');
-- Every other table in public: nothing (no rows, or no privilege at all).
do $$
declare
  t text;
  got text;
  seen text := '';
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
           and c.relname <> 'projects' order by c.relname loop
    got := test.try(format('select * from public.%I', t));
    if got not in ('rows:0', 'denied') then seen := seen || t || ' ' || got || '; '; end if;
  end loop;
  perform test.is(nullif(seen, ''), null, 'a guest sees nothing in any other table (people, events, tasks, the directory, account numbers, homework, school, food, settings, emails, guests)');
end;
$$;
select test.is((select count(*) from agenda('2026-11-01', '2026-12-31') a where a.kind <> 'project'), 0::bigint,
               'agenda gives a guest nothing but their project''s own dates (no events, tasks, meals or Google events)');
select test.throws($$select save_person('{"name": "X", "role": "kid"}'::jsonb, false)$$, 'Only', 'a guest can''t change the family');
select test.throws($$select add_to_list('Milk')$$, 'Only the family', 'a guest can''t add to the shopping list');
select test.throws($$select set_hearth_tag(gen_random_uuid(), 'family')$$, 'Only a parent', 'a guest can''t match Hearth people');
select test.throws($$select guest_contacts(test.project('Deck'))$$, 'That project isn''t shared with you.', 'guest_contacts: not someone else''s project');
select test.throws($$select add_project_guest(test.project('Kitchen'), 'pal@example.com', 'Pal')$$, 'Only a parent', 'a guest can''t add guests');
select test.throws($$select remove_project_guest(test.project('Kitchen'), 'riley@example.com')$$, 'Only a parent', 'a guest can''t remove guests');

-- The contractors on the Kitchen: the ones its trades link, with names and phones; never account details.
select test.is((select string_agg(name || ':' || coalesce(phone, '-') || ':' || kind || ':' || editable, ', ' order by name)
                from guest_contacts(test.project('Kitchen'))),
               'City Water:555-0160:account:false, Pat Lee:555-0100:contractor:true',
               'guest_contacts: the Kitchen''s contractors; City Water (account details saved) not editable');
select test.is((select string_agg(x, ', ') from unnest((select p.proargnames from pg_proc p where p.oid = 'public.guest_contacts(uuid)'::regprocedure)) x
                where x <> 'p_project'),
               'id, name, company, trade, phone, email, website, kind, editable', 'guest_contacts answers no notes, address or account number');

-- ---------------------------------------------------------------------
-- What a guest changes
-- ---------------------------------------------------------------------
select test.is(test.try($$update projects set name = 'Kitchen', summary = 'New cabinets', status = 'active',
                          documents_url = 'https://drive.google.com/drive/folders/abc123' where name = 'Kitchen'$$),
               'rows:1', 'a guest changes their project''s name, summary, status and documents link');
select test.is(test.try($$update projects set schedule = jsonb_set(schedule, '{project,holidays}', '["2026-12-25"]') where name = 'Kitchen'$$),
               'rows:1', '... and its schedule, keeping its contractor links');
select test.is(test.try($$update projects set name = 'Deck!' where name = 'Deck'$$), 'rows:0', 'a guest can''t change someone else''s project');
select test.is(test.try($$insert into projects (name) values ('Pool')$$), 'denied', 'a guest can''t make a project');
select test.is(test.try($$delete from projects$$), 'rows:0', 'a guest can''t delete a project');
select test.throws($$update projects set on_calendar = false where name = 'Kitchen'$$,
                   'Only the family can change the owner, the calendar switch or sharing.', 'a guest can''t take the project off the calendar');
select test.throws($$update projects set sharing_enabled = false where name = 'Kitchen'$$,
                   'Only the family can change the owner, the calendar switch or sharing.', 'a guest can''t turn sharing off');
select test.throws($$update projects set share_token = repeat('b', 24) where name = 'Kitchen'$$,
                   'Only the family can change the owner, the calendar switch or sharing.', 'a guest can''t make a new share link');
select test.throws(format($$update projects set owner_id = %L where name = 'Kitchen'$$, test.person('Alex')),
                   'Only the family can change the owner, the calendar switch or sharing.', 'a guest can''t change the owner');
select test.throws(format($$update projects set schedule = jsonb_set(schedule, '{trades,music}', '{"name": "Music", "contractor_id": "%s"}') where name = 'Kitchen'$$,
                          test.contractor('Rivera Music')),
                   'Link a trade only to a contractor on this project.', 'a guest can''t link a directory entry that isn''t on the project');
select test.throws($$update projects set documents_url = 'https://example.com/folder' where name = 'Kitchen'$$,
                   'violates check constraint', 'the documents link is a Google Drive address only');
select test.throws($$update projects set documents_url = 'http://drive.google.com/x' where name = 'Kitchen'$$,
                   'violates check constraint', '... over https');

-- Contractors: add one, edit one; never one with account details, or one not on the project.
select test.is((guest_save_contact(test.project('Kitchen'), '{"name": " Quinn Tile ", "company": "Quinn Tile Co", "trade": "Tile", "phone": "(201) 555-0170", "email": "Tile@Example.com"}')
                - 'id'),
               '{"name": "Quinn Tile", "company": "Quinn Tile Co", "trade": "Tile", "phone": "(201) 555-0170", "email": "tile@example.com", "website": null, "kind": "contractor", "editable": true}'::jsonb,
               'guest_save_contact: a new contractor (trimmed, email lower-cased)');
select test.is((select string_agg(name, ', ' order by name) from guest_contacts(test.project('Kitchen'))), 'City Water, Pat Lee, Quinn Tile',
               '... now on the project');
select test.is(test.try(format($$update projects set schedule = jsonb_set(schedule, '{trades,tile}', '{"name": "Tile", "contractor_id": "%s"}') where name = 'Kitchen'$$,
                               test.contractor('Quinn Tile'))),
               'rows:1', '... and the guest can link a trade to them');
select test.is(guest_save_contact(test.project('Kitchen'), jsonb_build_object('id', test.contractor('Pat Lee'), 'name', 'Pat Lee', 'phone', '(201) 555-0111')) ->> 'phone',
               '(201) 555-0111', 'a guest edits a contractor on the project');
select test.throws(format($$select guest_save_contact(test.project('Kitchen'), '{"id": "%s", "name": "City Water"}')$$, test.contractor('City Water')),
                   'This contractor has account details saved, so only a parent can change them.', 'a guest can''t edit one with account details');
select test.throws(format($$select guest_save_contact(test.project('Kitchen'), '{"id": "%s", "name": "Rivera"}')$$, test.contractor('Rivera Music')),
                   'That contractor isn''t on this project.', 'a guest can''t edit a directory entry not on the project');
select test.throws($$select guest_save_contact(test.project('Kitchen'), '{"id": "not-a-uuid", "name": "X"}')$$,
                   'That contractor isn''t on this project.', '... or something that isn''t an id');
select test.throws($$select guest_save_contact(test.project('Deck'), '{"name": "X"}')$$,
                   'That project isn''t shared with you.', 'a guest can''t add a contractor to someone else''s project');
select test.throws($$select guest_save_contact(test.project('Kitchen'), '{"name": "  "}')$$,
                   'Give the contractor a name', 'a contractor needs a name');
select test.throws($$select guest_save_contact(test.project('Kitchen'), '{"name": "X", "email": "nope"}')$$,
                   'doesn''t look like an email address', 'a bad email address');
:as_owner
select test.is((select project_id = test.project('Kitchen') and added_by = 'riley@example.com' from project_contacts
                where contractor_id = test.contractor('Quinn Tile')), true, 'project_contacts: who added Quinn Tile, to which project');
select test.is((select kind || ':' || updated_by from contractors where name = 'Quinn Tile'), 'contractor:riley@example.com',
               '... a contractor in the directory, stamped with the guest''s address');
select test.is((select account_number from contractor_secrets where contractor_id = test.contractor('City Water')), '0000-1111-2222',
               'City Water''s account details are as they were');
:as_adult
select test.is((select count(*) from project_contacts), 1::bigint, 'the family sees which contractors a guest added');
select test.throws($$update projects set documents_url = 'https://drive.google.com/drive/folders/def456' where name = 'Kitchen'$$,
                   'Only a parent or the project''s guest can change the documents folder.', 'an adult can''t change the documents link (the parents and the guest do)');
select test.is(test.try($$update projects set summary = 'Adult edit' where name = 'Kitchen'$$), 'rows:1', '... but changes the rest of the project, as before');
:as_admin
select test.is(test.try($$update projects set documents_url = 'https://drive.google.com/drive/folders/def456' where name = 'Kitchen'$$),
               'rows:1', 'a parent changes the documents link');
select test.is(test.try($$update projects set documents_url = null where name = 'Kitchen'$$), 'rows:1', '... or clears it');
update projects set documents_url = 'https://drive.google.com/drive/folders/def456' where name = 'Kitchen';
:as_adult
select test.is((select documents_url from projects where name = 'Kitchen'), 'https://drive.google.com/drive/folders/def456', 'the family reads the documents link');
:as_anon
select test.is((select (get_shared_project('aaaaaaaaaaaaaaaaaaaaaaaa'))::text like '%drive.google%'), false, 'the public share page never carries the documents link');
:as_adult
select test.is(test.try(format($$update projects set schedule = jsonb_set(schedule, '{trades,music}', '{"name": "Music", "contractor_id": "%s"}') where name = 'Kitchen'$$,
                               test.contractor('Rivera Music'))),
               'rows:1', 'a member links any directory entry (the guard is for guests only)');
update projects set schedule = jsonb_set(schedule, '{trades,music}', jsonb_build_object('name', 'Music', 'contractor_id', test.contractor('Rivera Music')))
where name = 'Kitchen';
:as_guest
select test.is((select string_agg(name, ', ' order by name) from guest_contacts(test.project('Kitchen'))), 'City Water, Pat Lee, Quinn Tile, Rivera Music',
               'a contractor a member links shows to the guest');
select test.is(test.try($$update projects set summary = 'Still going' where name = 'Kitchen'$$), 'rows:1',
               'a guest''s save keeps a member''s link to a contractor added by the family');
:as_guest2
select test.is((select string_agg(name, ', ') from projects), 'Deck', 'Quinn sees only the Deck');
select test.throws($$select guest_contacts(test.project('Kitchen'))$$, 'That project isn''t shared with you.', 'Quinn can''t see the Kitchen''s contractors');

-- ---------------------------------------------------------------------
-- Removing access
-- ---------------------------------------------------------------------
:as_admin
select test.is(remove_project_guest(test.project('Kitchen'), 'Riley@example.com'), true, 'a parent takes the Kitchen away from Riley');
select test.is(remove_project_guest(test.project('Kitchen'), 'riley@example.com'), false, '... again: nothing to take');
:as_guest
select test.is((select count(*) from projects), 0::bigint, 'Riley sees no projects at once');
select test.is(guest_whoami() -> 'projects', '[]'::jsonb, '... guest_whoami still knows them, with no projects');
select test.is(test.try($$update projects set summary = 'x'$$), 'rows:0', '... and can''t change any');
select test.throws($$select guest_contacts(test.project('Kitchen'))$$, 'That project isn''t shared with you.', '... or see its contractors');
:as_admin
select test.is(remove_guest('riley@example.com'), true, 'a parent removes Riley');
select test.is(remove_guest('riley@example.com'), false, '... again: no such guest');
:as_guest
select test.is(guest_whoami(), null, 'a removed guest: guest_whoami is null');
:as_owner
select test.is(hook_family_only_signup('{"user": {"email": "riley@example.com"}}') -> 'error' ->> 'message', 'This email is not on the family list.',
               'the sign-up hook turns a removed guest''s address down');
-- A project deleted: its guest links go with it.
delete from projects where name = 'Deck';
select test.is((select count(*) from project_guests), 0::bigint, 'deleting a project removes its guest links');
:as_guest2
select test.is(guest_whoami() -> 'projects', '[]'::jsonb, 'Quinn: no projects');
-- An address on both lists (a guest later made a member): the member wins.
:as_owner
insert into members (email, name, role) values ('quinn@example.com', 'Quinn', 'member');
:as_guest2
select test.is(guest_whoami(), null, 'a guest who is also a member: guest_whoami is null (they sign in as family)');
