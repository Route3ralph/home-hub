-- Recipes (migration 0013, docs/v1.2-kitchen.md §19): the table's row-level security and grants (every member
-- reads and changes it; anon, a signed-in stranger, a removed member and a project guest get nothing; service_role
-- nothing either), its checks (title, link, label, note), its cleaning and stamps, and the household's Recipes folder
-- (a Drive address only; only the parents change it). The household is fixtures.sql's: Alex (admin), Sam (adult).
\ir roles.sql
\ir fixtures.sql
\set as_guest 'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "riley@example.com"}''; set role authenticated;'

:as_owner
select test.is(hub_schema_version(), 13, 'hub_schema_version is 13 (0013 makes it 13)');
select test.is((select relrowsecurity from pg_class where oid = 'public.recipes'::regclass), true, 'recipes has row-level security');
select test.is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
                where table_schema = 'public' and table_name = 'recipes' and grantee = 'authenticated'), 'DELETE,SELECT',
               'authenticated: select and delete on the table (insert and update on its own columns only, below)');
select test.is((select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
                where table_schema = 'public' and table_name = 'recipes' and grantee = 'authenticated' and privilege_type = 'INSERT'),
               'id,label,note,title,url', 'members insert only the id, title, link, label and note');
select test.is((select count(*) from information_schema.role_table_grants
                where table_schema = 'public' and table_name = 'recipes' and grantee in ('anon', 'service_role', 'PUBLIC')), 0::bigint,
               'nothing on recipes for anon, service_role or public');
select test.is((select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
                where table_schema = 'public' and table_name = 'recipes' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
               'label,note,title,url', 'members update only the title, link, label and note (never the stamps)');
-- A project guest (not a member).
insert into public.guests (email, name) values ('riley@example.com', 'Riley Designer');
insert into public.recipes (title, url, label, note) values ('Lentil soup', 'https://cooking.example.com/lentil-soup', 'dinner', 'Freezes well');

-- ---------------------------------------------------------------------
-- Who can do what
-- ---------------------------------------------------------------------
insert into test.samples (tbl, ins, upd) values ('recipes',
  $$insert into public.recipes (title) values ('Toast')$$,
  $$update public.recipes set note = 'x'$$);
:as_anon
select test.matrix('anon', 'recipes', 'denied', 'denied', 'denied', 'denied');
:as_stranger
select test.matrix('stranger', 'recipes', 'rows:0', 'denied', 'rows:0', 'rows:0');
:as_removed
select test.matrix('removed member', 'recipes', 'rows:0', 'denied', 'rows:0', 'rows:0');
:as_guest
select test.matrix('project guest', 'recipes', 'rows:0', 'denied', 'rows:0', 'rows:0');
:as_service
select test.matrix('service_role', 'recipes', 'denied', 'denied', 'denied', 'denied');
:as_adult
select test.matrix('adult', 'recipes', 'rows:1', 'rows:1', 'rows:1', 'rows:1');
:as_admin
select test.matrix('admin', 'recipes', 'rows:1', 'rows:1', 'rows:1', 'rows:1');

-- ---------------------------------------------------------------------
-- An adult adds, changes and deletes; the stamps and the cleaning
-- ---------------------------------------------------------------------
:as_adult
insert into public.recipes (title, url, label, note)
values (E'  High-fiber   chickpea\nlunches ', 'https://www.example.com/high-fiber-lunch-recipes-with-chickpeas', 'lunch', E'  Try the\nsalad  ');
select test.is((select title || ' | ' || note || ' | ' || label || ' | ' || created_by || ' | ' || updated_by from public.recipes where label = 'lunch'),
               'High-fiber chickpea lunches | Try the salad | lunch | sam@example.com | sam@example.com',
               'an adult adds one: the title and note on one line, stamped with who');
update public.recipes set note = '   ' where label = 'lunch';
select test.is((select note from public.recipes where label = 'lunch'), null, 'a blank note is cleared');
:as_admin
update public.recipes set title = 'Chickpea lunches' where label = 'lunch';
select test.is((select title || ' | ' || created_by || ' | ' || updated_by from public.recipes where label = 'lunch'),
               'Chickpea lunches | sam@example.com | alex@example.com', 'a parent changes it: updated_by follows, created_by stays');
select test.throws($$update public.recipes set created_by = 'x'$$, 'permission denied', 'the stamps can''t be written');
insert into public.recipes (title, url) values ('Pancakes', 'https://drive.google.com/file/d/EXAMPLE-file-id/view');
select test.is((select label || ' ' || (url is not null) from public.recipes where title = 'Pancakes'), 'dinner true',
               'the label defaults to dinner; a Drive file is a link like any other');
insert into public.recipes (title) values ('Grandma''s stew');
select test.is((select count(*) from public.recipes where title = 'Grandma''s stew' and url is null), 1::bigint, 'a recipe needs no link');
:as_adult
delete from public.recipes where title = 'Pancakes';
select test.is((select count(*) from public.recipes where title = 'Pancakes'), 0::bigint, 'an adult deletes one');

-- ---------------------------------------------------------------------
-- The checks
-- ---------------------------------------------------------------------
select test.throws($$insert into public.recipes (title) values ('   ')$$, 'violates check constraint', 'a title that cleans to nothing is refused');
select test.throws($$insert into public.recipes (title) values (null)$$, 'violates not-null constraint', 'a recipe needs a title');
insert into public.recipes (title, note) values (repeat('t', 90), repeat('n', 310));
select test.is((select char_length(title) || ' ' || char_length(note) from public.recipes where title like 'ttt%'), '80 300',
               'a title over 80 and a note over 300 are cut to length (as a dinner''s are)');
delete from public.recipes where title like 'ttt%';
select test.throws($$insert into public.recipes (title, label) values ('Soup', 'dessert')$$, 'violates check constraint', 'a label outside the five is refused');
select test.throws($$insert into public.recipes (title, url) values ('Soup', 'http://cooking.example.com/soup')$$, 'violates check constraint', 'a link must be https');
select test.throws($$insert into public.recipes (title, url) values ('Soup', 'javascript:alert(1)')$$, 'violates check constraint', 'a javascript: link is refused');
select test.throws($$insert into public.recipes (title, url) values ('Soup', 'https://cooking.example.com/a b')$$, 'violates check constraint', 'a link with a space is refused');
select test.throws($$insert into public.recipes (title, url) values ('Soup', 'https://cooking.example.com/"><script>')$$, 'violates check constraint', 'a link with quotes or angle brackets is refused');
select test.throws(format('insert into public.recipes (title, url) values (''Soup'', %L)', 'https://cooking.example.com/' || chr(8238) || 'x'), 'violates check constraint',
                   'a link with a bidi character is refused');
select test.throws(format('insert into public.recipes (title, url) values (''Soup'', %L)', 'https://' || repeat('a', 501)), 'violates check constraint', 'a link over 500 after https:// is refused');

-- ---------------------------------------------------------------------
-- The Recipes folder
-- ---------------------------------------------------------------------
:as_admin
update public.household set recipes_folder_url = 'https://drive.google.com/drive/folders/EXAMPLE-folder-id';
select test.is((select recipes_folder_url from public.household), 'https://drive.google.com/drive/folders/EXAMPLE-folder-id', 'a parent sets the Recipes folder');
select test.throws($$update public.household set recipes_folder_url = 'https://evil.example.com/drive.google.com/'$$, 'violates check constraint', 'only a drive.google.com address');
select test.throws($$update public.household set recipes_folder_url = 'https://drive.google.com/x"onclick'$$, 'violates check constraint', 'no quotes in it');
:as_adult
select test.is(test.try($$update public.household set recipes_folder_url = null$$), 'rows:0', 'an adult can''t change it (the household is the parents'')');
:as_admin
update public.household set recipes_folder_url = null;
select test.is((select recipes_folder_url from public.household), null, 'a parent clears it');
:as_guest
select test.is(test.try($$select recipes_folder_url from public.household$$), 'rows:0', 'a project guest doesn''t see the folder');
