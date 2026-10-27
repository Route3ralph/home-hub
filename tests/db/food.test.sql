-- Food (migration 0004, docs/v1.2-kitchen.md): meals (who can do what, the checks, cleaning and
-- stamps); the shopping list for members (amounts, aisles, the other language, the lock, ticking
-- against the state the phone saw, the cap, shopping_list(), editing, two phones at once); the list
-- on My day (who gets it, the switch, the lock, Undo, the caps, midnight); and meals on My day, in
-- day_text and in the morning email. The household is fixtures.sql's: Alex (admin), Sam (adult),
-- Jordan (a parent who was removed), Taylor (kid) and Morgan, the helper, who reads Spanish.
\ir roles.sql
\ir fixtures.sql

-- Helpers (owner).
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
-- A line as the database has it, by name and lock, whoever is asking.
create function pg_temp.line(p_name text, p_private boolean default false) returns public.shopping_items
language sql stable security definer as $$
  select * from public.shopping_items where name_key = lower(p_name) and private = p_private
$$;
-- One entry of a list in a reply (to_buy, bought, items, suggest), by name.
create function pg_temp.el(r jsonb, p_key text, p_name text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(r -> p_key) x where x ->> 'name' = p_name limit 1
$$;
-- The names in one list of a reply, in its order.
create function pg_temp.names(r jsonb, p_key text) returns text language sql immutable as $$
  select string_agg(x ->> 'name', ', ' order by n) from jsonb_array_elements(r -> p_key) with ordinality t (x, n)
$$;
-- What an add makes of a text, undone at once: "name | note | aisle" (run as a member).
create function pg_temp.parse(p_text text) returns text language plpgsql as $$
declare
  r jsonb;
  i public.shopping_items;
begin
  r := public.add_to_list(p_text);
  select * into i from public.shopping_items where id = (r ->> 'item_id')::uuid;
  raise exception using errcode = 'TT001', message = concat_ws(' | ', i.name, coalesce(i.note, '-'), i.aisle);
exception when sqlstate 'TT001' then
  return sqlerrm;
end;
$$;
-- The meal rows of an email's Today, without their ids.
create function pg_temp.meal_rows(j jsonb) returns jsonb language sql immutable as $$
  select jsonb_agg(x - 'item_id' order by n) from jsonb_array_elements(j -> 'today') with ordinality t (x, n) where x ->> 'kind' = 'meal'
$$;
-- How long a statement takes, in milliseconds: the best of three, after one run to warm up.
create function pg_temp.ms(p_sql text) returns numeric language plpgsql as $$
declare
  t    timestamptz;
  best numeric;
begin
  execute p_sql;
  for i in 1 .. 3 loop
    t := clock_timestamp();
    execute p_sql;
    best := least(best, extract(epoch from clock_timestamp() - t) * 1000);
  end loop;
  return round(best, 1);
end;
$$;
-- How many changes and ticks Morgan's link has made on a day.
create function pg_temp.used(p_day date) returns text language sql stable security definer as $$
  select coalesce((select u.changes || ' ' || u.ticks from public.my_day_use u
                   where u.person_id = (select id from public.people where name = 'Morgan') and u.day = p_day), 'none')
$$;

-- The household's own items, so the email and day_text have something besides meals.
insert into events (title, start_date, start_time, responsible_id, participant_ids) values
  ('Dentist', '2026-10-27', '10:00', test.person('Alex'), '{}'),
  ('Piano', '2026-10-27', '16:00', test.person('Taylor'), array[test.person('Sam')]);
insert into tasks (title, responsible_id, due_date) values
  ('Trash', test.person('Morgan'), '2026-10-27'),
  ('Water plants', test.person('Morgan'), '2026-10-20');

-- ---------------------------------------------------------------------
-- The email with no meal: exactly 0003's (§3.6)
-- ---------------------------------------------------------------------
:as_service
select test.is((select count(*) || ' ' || count(*) filter (where public.digest_for(p.id, g::date) is not distinct from private.digest_for_v3(p.id, g::date))
                from public.people p cross join generate_series(date '2026-10-25', date '2026-11-07', interval '1 day') g),
               '70 70', 'digest_for with no meal: equal to private.digest_for_v3 (0003''s body) for every person and the 14 days around Nov 1');
:as_admin
select test.is(test.can($$select private.digest_for_v3(test.person('Alex'), '2026-10-27')$$), 'denied',
               'private.digest_for_v3 keeps its grant: hub-jobs only');

-- ---------------------------------------------------------------------
-- Meals: who can do what, and the rules (§3.2, §5)
-- ---------------------------------------------------------------------
begin;
:as_owner
insert into test.samples (tbl, ins, upd) values
  ('meals', $$insert into public.meals (day, kind, title) values ('2026-10-31', 'cook', 'Pizza')$$, $$update public.meals set title = title$$);
insert into meals (day, kind, title, cook_id) values ('2026-10-30', 'cook', 'Chili', test.person('Sam'));
--                                   select    insert    update    delete
:as_anon
select test.matrix('anon', 'meals',     'denied', 'denied', 'denied', 'denied');
:as_stranger
select test.matrix('stranger', 'meals', 'rows:0', 'denied', 'rows:0', 'rows:0');
:as_removed
select test.matrix('removed', 'meals',  'rows:0', 'denied', 'rows:0', 'rows:0');
:as_adult
select test.matrix('Sam', 'meals',      'rows:1', 'rows:1', 'rows:1', 'rows:1');
:as_admin
select test.matrix('Alex', 'meals',     'rows:1', 'rows:1', 'rows:1', 'rows:1');

select test.throws($$insert into meals (day, kind, title) values ('2026-10-30', 'cook', 'Soup')$$, 'duplicate key',
                   'meals: one row per day and slot');
select test.is(test.try($$insert into meals (day, slot, kind, title) values ('2026-10-30', 'lunch', 'cook', 'Soup')$$), 'rows:1',
               '... a lunch on the same day is its own row');
select test.is(test.try($$insert into meals (day, slot, kind, title, cook_id, note, link, private)
                          values ('2026-10-30', 'dinner', 'cook', 'White chili', null, null, null, false)
                          on conflict (day, slot) do update set kind = excluded.kind, title = excluded.title, cook_id = excluded.cook_id,
                            note = excluded.note, link = excluded.link, private = excluded.private$$), 'rows:1',
               'the Food page''s save: an upsert on (day, slot), with the columns members may write');
select test.throws($$insert into meals (day, kind) values ('2026-11-01', 'cook')$$, 'violates check constraint', 'a cooked meal needs a title');
select test.throws($$insert into meals (day, kind, title) values ('2026-11-01', 'cook', E' \u200b\n ')$$, 'violates check constraint',
                   '... and a title of spaces and invisible characters is none');
select test.throws($$insert into meals (day, kind, title) values ('2026-11-01', 'leftovers', 'Lasagna')$$, 'violates check constraint',
                   'a quick kind has no title');
select test.throws($$insert into meals (day, kind, link) values ('2026-11-01', 'takeout', 'https://menu.example.com/')$$, 'violates check constraint',
                   '... and no link (a recipe link is for a cooked meal)');
select test.is(test.try($$insert into meals (day, kind, cook_id) values ('2026-11-01', 'leftovers', test.person('Taylor'))$$), 'rows:1',
               'leftovers: someone can be on dinner');
select test.is(test.try($$insert into meals (day, kind, cook_id) values ('2026-11-01', 'takeout', test.person('Taylor'))$$), 'rows:1',
               'takeout: someone can be on dinner');
select test.throws($$insert into meals (day, kind, cook_id) values ('2026-11-01', 'out', test.person('Sam'))$$, 'violates check constraint',
                   'eating out: nobody is on it');
select test.throws($$insert into meals (day, kind, cook_id) values ('2026-11-01', 'fend', test.person('Sam'))$$, 'violates check constraint',
                   'fend for yourself: nobody is on it');
select test.throws($$insert into meals (day, slot, kind, title) values ('2026-11-01', 'snack', 'cook', 'Fruit')$$, 'violates check constraint',
                   'the slots are breakfast, lunch and dinner');

-- Recipe links: https, printable ASCII only, 4 to 500 characters after "https://".
select test.is(test.try($$update meals set link = 'https://cooking.example.com/chili?serves=4&x=%C3%B1#step-2' where day = '2026-10-30' and slot = 'dinner'$$),
               'rows:1', 'a recipe link: https and printable ASCII (as new URL().href gives it)');
select test.is(test.try(format($$update meals set link = %L where day = '2026-10-30' and slot = 'dinner'$$, 'https://' || repeat('a', 500))), 'rows:1',
               '... up to 500 characters after https://');
select test.throws(format($$update meals set link = %L where day = '2026-10-30' and slot = 'dinner'$$, l), 'violates check constraint',
                   'a recipe link is refused: ' || why)
from (values ('http://cooking.example.com/chili', 'http'),
             ('https://cooking.example.com/chili soup', 'a space'),
             ('https://cooking.example.com/"chili"', 'a double quote'),
             ('https://cooking.example.com/<chili>', 'angle brackets'),
             (E'https://cooking.example.com/\u202echili', 'U+202E (a bidi override)'),
             (E'https://cooking.example.com/\u200bchili', 'U+200B (a zero-width space)'),
             (E'https://cooking.example.com/\u0001chili', 'U+0001 (a control character)'),
             ('https://abc', 'fewer than 4 characters after https://'),
             ('https://' || repeat('a', 501), 'more than 500 characters after https://'),
             ('javascript:alert(1)', 'another scheme')) v (l, why);

-- Titles and notes are cleaned to one line.
insert into meals (day, kind, title, note) values ('2026-11-02', 'cook', E'Taco\nnight \u202e\u200bfiesta', E'Thaw\tthe chicken\u2028tonight');
select test.is((select title || ' | ' || note from meals where day = '2026-11-02'), 'Taco night fiesta | Thaw the chicken tonight',
               'a title with a newline, a bidi override and a zero-width space is cleaned to one line (the note too)');
update meals set title = repeat('x', 81), note = repeat('y', 301) where day = '2026-11-02';
select test.is((select char_length(title) || ' ' || char_length(note) from meals where day = '2026-11-02'), '80 300',
               '81 characters of title become 80 (301 of note, 300)');

-- Audit columns come from the stamp; members write a meal's own columns, the lock included.
:as_adult
insert into meals (day, kind, title) values ('2026-11-03', 'cook', 'Curry');
:as_admin
update meals set note = 'Mild' where day = '2026-11-03';
select test.is((select created_by || ' ' || updated_by from meals where day = '2026-11-03'), 'sam@example.com alex@example.com',
               'created_by and updated_by come from the stamp (Sam added it, Alex changed it)');
select test.is(test.try($$update meals set private = true where day = '2026-11-03'$$), 'rows:1', 'members lock a meal (private is theirs to write)');
select test.is(test.try($$update meals set created_by = 'casey@example.com'$$), 'denied', 'members cannot write the audit columns');
select test.is(test.try($$update meals set id = gen_random_uuid()$$), 'denied', '... or the id');
select test.is(test.try($$insert into meals (id, day, kind, title) values (gen_random_uuid(), '2026-11-04', 'cook', 'Stew')$$), 'denied',
               '... nor insert one with its own id');
rollback;

-- ---------------------------------------------------------------------
-- Meals on My day, in day_text and in the morning email (§3.4, §7.1, §9)
-- ---------------------------------------------------------------------
:as_owner
insert into meals (day, slot, kind, title, cook_id, note, link, private) values
  ('2026-10-27', 'dinner', 'cook', 'Tacos', test.person('Morgan'), 'Chicken is in the freezer', 'https://cooking.example.com/tacos', false),
  ('2026-10-27', 'lunch', 'cook', 'Soup', test.person('Sam'), 'Use the big pot', null, true),
  ('2026-10-28', 'dinner', 'leftovers', null, test.person('Taylor'), 'Lasagna, 350° for 20 min', null, false),
  ('2026-10-29', 'dinner', 'takeout', null, test.person('Morgan'), null, null, false),
  ('2026-10-30', 'dinner', 'cook', 'Surprise cake', test.person('Sam'), 'Hide the box', null, true),
  ('2026-10-31', 'dinner', 'out', null, null, null, null, false),
  ('2026-11-02', 'dinner', 'cook', 'Pasta', test.person('Alex'), null, null, false);

:as_anon
select test.is(get_person_day(test.token('Morgan')) -> 'days' -> 0 -> 'meals',
               '[{"slot": "lunch", "label": "Almuerzo", "title": "Asunto privado", "cook": "Sam", "cook_word": "Cocina Sam", "mine": false},
                 {"slot": "dinner", "label": "Cena", "title": "Tacos", "cook": "Morgan", "cook_word": "Cocinas tú", "mine": true,
                  "note": "Chicken is in the freezer", "link": "https://cooking.example.com/tacos"}]'::jsonb,
               'My day (Morgan, Spanish): today''s meals, lunch before dinner; a locked one she isn''t on is "Asunto privado"; hers with its note and link');
select test.is(get_person_day(test.token('Morgan')) -> 'days' -> 1 -> 'meals',
               '[{"slot": "dinner", "label": "Cena", "title": "Sobras", "cook": "Taylor", "cook_word": "Taylor se encarga de la cena", "mine": false}]'::jsonb,
               '... tomorrow''s leftovers: who''s on dinner, without the note (it isn''t hers)');
select test.is(get_person_day(test.token('Taylor')) -> 'days' -> 0 -> 'meals',
               '[{"slot": "lunch", "label": "Lunch", "title": "Private item", "cook": "Sam", "cook_word": "Sam cooks", "mine": false},
                 {"slot": "dinner", "label": "Dinner", "title": "Tacos", "cook": "Morgan", "cook_word": "Morgan cooks", "mine": false}]'::jsonb,
               'a kid''s My day: title and who cooks, "Private item" for a locked meal, no note or link');
select test.is(get_person_day(test.token('Taylor')) -> 'days' -> 1 -> 'meals',
               '[{"slot": "dinner", "label": "Dinner", "title": "Leftovers", "cook": "Taylor", "cook_word": "You''re on dinner", "mine": true,
                  "note": "Lasagna, 350° for 20 min"}]'::jsonb,
               '... and the note of the one the kid is on ("You''re on dinner"; no link key when there is none)');
select test.is(get_person_day(test.token('Sam')) -> 'days' -> 0 -> 'meals' -> 0,
               '{"slot": "lunch", "label": "Lunch", "title": "Soup", "cook": "Sam", "cook_word": "You cook", "mine": true, "note": "Use the big pot"}'::jsonb,
               'a locked meal shows its title to the person on it');
select test.is(get_person_day(test.token('Morgan')) ? 'list', false,
               'no list button before the household has started a list (so the same-output check is unchanged)');
:as_owner
set hub.now = '2026-10-31 09:00 America/New_York';
:as_anon
select test.is(get_person_day(test.token('Taylor')) -> 'days' -> 0 -> 'meals',
               '[{"slot": "dinner", "label": "Dinner", "title": "Eating out", "cook": null, "cook_word": null, "mine": false}]'::jsonb,
               'eating out: its word, and nobody on it');
select test.is(get_person_day(test.token('Taylor')) -> 'days' -> 1 ? 'meals', false, 'a day with no meal has no meals key');
begin;
:as_owner
update people set active = false where name = 'Taylor';
set hub.now = '2026-10-28 09:00 America/New_York';
:as_anon
select test.is(get_person_day(test.token('Morgan')) -> 'days' -> 0 -> 'meals' -> 0 ->> 'cook_word', null,
               'someone off the family list counts as nobody on the meal');
rollback;
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';

-- day_text: the line of the person on the meal, after the day's items and before Late.
:as_admin
select test.is(day_text(test.person('Morgan'), '2026-10-27'),
               E'Morgan · mar 27 oct\n☐ Trash\nCena: Tacos · Cocinas tú\nAtrasado:\n☐ Water plants (20 oct)',
               'day_text (Spanish): the meal she cooks, after the day''s items and before Late; never its note or link');
select test.is(day_text(test.person('Morgan'), '2026-10-29'),
               E'Morgan · jue 29 oct\nCena: Comida para llevar · Te encargas tú\nAtrasado:\n☐ Water plants (20 oct)\n☐ Trash (27 oct)',
               'day_text: takeout she''s on ("Te encargas tú")');
select test.is(day_text(test.person('Taylor'), '2026-10-28'), E'Taylor · Wed Oct 28\nDinner: Leftovers · You''re on dinner',
               'day_text (English): leftovers ("You''re on dinner"); a day with only that line no longer says "Nothing planned"');
select test.is(day_text(test.person('Sam'), '2026-10-30'), E'Sam · Fri Oct 30\nDinner: Surprise cake · You cook',
               'day_text: a locked meal''s title, to the person on it (no note)');
select test.is(day_text(test.person('Alex'), '2026-10-28'), E'Alex · Wed Oct 28\nNothing planned', 'day_text: no line for someone not on the meal');
select test.is(day_text(test.person('Taylor'), '2026-10-27'), E'Taylor · Tue Oct 27\n4:00pm Piano · with Sam', '... nor for the meals of the day');
begin;
:as_owner
update people set active = false where name = 'Taylor';
:as_admin
select test.is(day_text(test.person('Taylor'), '2026-10-28'), E'Taylor · Wed Oct 28\nNothing planned', 'day_text: someone off the family list is on no meal');
rollback;

-- The morning email.
:as_service
select test.is(pg_temp.meal_rows(digest_for(test.person('Morgan'), '2026-10-27')),
               '[{"kind": "meal", "occurrence": "2026-10-27", "time": "Almuerzo", "title": "Asunto privado", "detail": "Cocina Sam",
                  "contractor_phone": null, "status": "open"},
                 {"kind": "meal", "occurrence": "2026-10-27", "time": "Cena", "title": "Tacos", "detail": "Cocinas tú · Chicken is in the freezer",
                  "contractor_phone": null, "status": "open"}]'::jsonb,
               'email (Morgan, Spanish): one row per meal, lunch before dinner; the locked one she isn''t on is "Asunto privado"; hers with the note');
select test.is((select (j -> 'today' -> -1 ->> 'item_id')::uuid = (select id from meals where day = '2026-10-27' and slot = 'dinner')
                       and j -> 'today' -> -3 = v -> 'today' -> -1 and jsonb_array_length(j -> 'today') = jsonb_array_length(v -> 'today') + 2
                from (select digest_for(test.person('Morgan'), '2026-10-27') as j, private.digest_for_v3(test.person('Morgan'), '2026-10-27') as v) x),
               true, '... at the end of Today, after 0003''s rows, with the meal''s id');
select test.is((select (j - 'today') = (v - 'today')
                from (select digest_for(test.person('Morgan'), '2026-10-27') as j, private.digest_for_v3(test.person('Morgan'), '2026-10-27') as v) x),
               true, '... her day has items, so the subject and every other key are 0003''s');
select test.is(digest_for(test.person('Sam'), '2026-10-28') ->> 'subject', 'Wed Oct 28: Dinner: Leftovers · Taylor''s on dinner',
               'a quiet day (0003 said "Nothing planned"): the subject names the dinner');
select test.is(digest_for(test.person('Taylor'), '2026-10-28') ->> 'subject', 'Wed Oct 28: Dinner: Leftovers · You''re on dinner',
               '... for the person on it, in their words');
select test.is(digest_for(test.person('Alex'), '2026-11-02') ->> 'subject', 'Mon Nov 2: Dinner: Pasta · You cook', '... "You cook"');
select test.is(digest_for(test.person('Alex'), '2026-10-30') ->> 'subject', 'Fri Oct 30: Dinner: Private item',
               'a locked dinner is "Dinner: Private item" in the subject for a parent');
select test.is(digest_for(test.person('Sam'), '2026-10-30') ->> 'subject', 'Fri Oct 30: Dinner: Private item', '... and for the cook (subjects show on lock screens)');
select test.is(pg_temp.meal_rows(digest_for(test.person('Sam'), '2026-10-30')) -> 0 ->> 'title', 'Surprise cake', '... though the cook''s email has its title');
select test.is(pg_temp.meal_rows(digest_for(test.person('Alex'), '2026-10-30')) -> 0 ->> 'title', 'Surprise cake', '... and a parent''s');
select test.is(pg_temp.meal_rows(digest_for(test.person('Morgan'), '2026-10-30')) -> 0,
               '{"kind": "meal", "occurrence": "2026-10-30", "time": "Cena", "title": "Asunto privado", "detail": "Cocina Sam",
                 "contractor_phone": null, "status": "open"}'::jsonb,
               'the helper''s email: a locked meal she isn''t on is "Asunto privado", without its note');
select test.is((select (digest_for(test.person(n), d) ->> 'empty') || ' ' || (private.digest_for_v3(test.person(n), d) ->> 'empty')
                from (values ('Taylor', date '2026-10-28')) v (n, d)), 'false true',
               'dinner alone sends an email to the person on it (empty false)');
select test.is(digest_for(test.person('Sam'), '2026-10-28') ->> 'empty', 'true', '... and to nobody else (Sam: still empty)');
select test.is((select (j - 'today' - 'subject' - 'empty') = (v - 'today' - 'subject' - 'empty')
                from (select digest_for(test.person('Taylor'), '2026-10-28') as j, private.digest_for_v3(test.person('Taylor'), '2026-10-28') as v) x),
               true, '... every other key is 0003''s');
select test.ok((select x ->> 'text' from jsonb_array_elements(digest_for(test.person('Alex'), '2026-10-28') -> 'people') x
                where x ->> 'name' = 'Taylor') like '%Dinner: Leftovers · You''re on dinner%',
               'the parents'' blocks for each kid and helper get the meal line too (through day_text)');
begin;
:as_owner
update meals set cook_id = test.person('Morgan') where day = '2026-10-30';
:as_service
select test.is(pg_temp.meal_rows(digest_for(test.person('Morgan'), '2026-10-30')) -> 0 ->> 'title', 'Surprise cake',
               '... and its title when she is the one on it');
:as_owner
update people set digest_day = 'tomorrow' where name = 'Sam';
:as_service
select test.is((select (j -> 'labels' ->> 'today') || ' | ' || (pg_temp.meal_rows(j) -> 0 ->> 'title')
                from (select digest_for(test.person('Sam'), '2026-10-28') as j) x), 'Tomorrow | Leftovers',
               'the evening email is about the next day, so it shows the next day''s meal');
rollback;

-- ---------------------------------------------------------------------
-- The word list, aisles and the other language (§3.4, §4.4)
-- ---------------------------------------------------------------------
:as_owner
select test.ok((select count(*) from private.food_words()) between 140 and 170, 'food_words: about 150 everyday things');
select test.is((select count(*) - count(distinct lower(en)) from private.food_words()), 0::bigint, '... no English word twice');
select test.is((select count(es) - count(distinct lower(es)) from private.food_words()), 0::bigint, '... no Spanish word twice');
select test.is((select string_agg(distinct aisle, ',' order by aisle) from private.food_words()),
               'bakery,dairy,drinks,frozen,household,meat,pantry,personal,produce', '... every aisle but Other has words');
select test.is((select string_agg(w, ', ') from private.food_words() f cross join lateral (values (f.en), (f.es)) x (w)
                where lower(w) in ('pan', 'red', 'once', 'tuna', 'pastel', 'carpeta', 'embarazada')), null,
               '... words that mean something else in the other language are left out');
select test.is(private.guess_aisle(w), want, 'guess_aisle: ' || w || ' → ' || want)
from (values ('milk', 'dairy'), ('Leche', 'dairy'), ('tortillas', 'bakery'), ('detergente', 'household'), ('zorblax', 'other'),
             ('Huevo', 'dairy'), ('CHAMPÚ', 'personal'), ('Tomato', 'produce'), ('chicken broth', 'pantry'), ('ice cream', 'frozen'),
             ('pepper', 'pantry'), ('green peppers', 'produce'), ('papel higiénico', 'household'), ('2% milk', 'dairy'), ('', 'other')) v (w, want);
select test.is(coalesce(private.food_other(n, l), 'null'), want, 'food_other: ' || coalesce(n, 'null') || ' in ' || l || ' → ' || want)
from (values ('Leche', 'en', 'milk'), ('Milk', 'es', 'leche'), ('MILK', 'es', 'leche'), ('Manzana', 'en', 'apples'), ('Apple', 'es', 'manzanas'),
             ('Champu', 'en', 'shampoo'), ('Milk', 'en', 'null'), ('Leche', 'es', 'null'), ('Tortillas', 'en', 'null'), ('Melón', 'en', 'null'),
             ('2% milk', 'es', 'null'), ('zorblax', 'es', 'null'), (null, 'en', 'null'), ('Leche', 'fr', 'null')) v (n, l, want);
:as_admin
select test.is(private.food_other('Leche', 'en'), 'milk', 'members may call food_other (shopping_list runs as them)');
select test.is(test.can($$select private.guess_aisle('milk')$$), 'denied', '... but not guess_aisle');
select test.is(test.try($$select * from private.food_pairs$$), 'denied', '... nor read food_pairs (only food_other does)');

-- food_other is a lookup in private.food_pairs, which the migration works out once from food_words.
-- Before that, it worked every pair out on each call (about 3.5 ms, and it runs once per line in
-- every poll of the list). That version is kept here, word for word, as the reference: the two give
-- the same answer for every word of food_words read in English and in Spanish, as written, in
-- capitals, with a plural or singular ending, without accents, with spacing and punctuation around it,
-- and for names that aren't food words; and for empty, blank and unknown names, and in another
-- language or none.
:as_owner
create function pg_temp.food_other_v0(p_name text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  with n as (
    select x.name,
           array_remove(array[x.name, case when char_length(x.name) >= 4 and right(x.name, 1) = 's' then left(x.name, -1) end,
                                      case when char_length(x.name) >= 5 and right(x.name, 2) = 'es' then left(x.name, -2) end], null) as forms
    from (select btrim(regexp_replace(translate(lower(coalesce(p_name, '')),
                                                'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                                                'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc'),
                                      '[^a-z0-9]+', ' ', 'g')) as name) x
  ),
  -- Each pair as (the word to find, its forms, the word to give, its forms).
  f as (
    select w.en, z.side, z.word, z.give,
           array_remove(array[z.word, case when char_length(z.word) >= 4 and right(z.word, 1) = 's' then left(z.word, -1) end,
                                      case when char_length(z.word) >= 5 and right(z.word, 2) = 'es' then left(z.word, -2) end], null) as forms,
           array_remove(array[z.give_n, case when char_length(z.give_n) >= 4 and right(z.give_n, 1) = 's' then left(z.give_n, -1) end,
                                        case when char_length(z.give_n) >= 5 and right(z.give_n, 2) = 'es' then left(z.give_n, -2) end], null) as give_forms
    from private.food_words() w
    cross join lateral (
      select x.side, x.give,
             btrim(regexp_replace(translate(lower(x.word),
                                            'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                                            'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc'),
                                  '[^a-z0-9]+', ' ', 'g')) as word,
             btrim(regexp_replace(translate(lower(x.give),
                                            'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                                            'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc'),
                                  '[^a-z0-9]+', ' ', 'g')) as give_n
      from (values ('es', w.en, w.es), ('en', w.es, w.en)) x (side, word, give)   -- side: the language given
      where x.word is not null and x.give is not null
    ) z
  )
  select f.give
  from n join f on f.side = p_lang and f.forms && n.forms and not (f.give_forms && n.forms)
  where n.name <> ''
  order by (f.word = n.name) desc, f.en
  limit 1;
$$;
-- The probes and the old answers, worked out once (the old one takes its 3.5 ms a call here too):
-- every word as written and in five other spellings, and some odd names, read in English and in
-- Spanish; then empty, blank and a few other names read in English, Spanish, French and no language.
create temp table food_was as
select p.n, x.l, pg_temp.food_other_v0(p.n, x.l) as was
from (select v.n
      from (select f.en as w from private.food_words() f union select f.es from private.food_words() f
            union select p.give from private.food_pairs p) w
      cross join lateral (values (w.w), (upper(w.w) || 'S'), (initcap(w.w) || 'es'), (left(w.w, -1)), (upper(left(w.w, -2))),
                                 (E' \t' || translate(w.w, 'áéíóúñü', 'aeiounu') || E' !\n')) v (n)
      where w.w is not null
      union
      select e.n
      from (values ('2 milk'), ('chicken broth'), ('green peppers'), ('papel higiénico'), ('Leche: 2'), ('ice-cream'),
                   ('ICE   CREAM'), ('peanut butter'), ('crema de cacahuate'), ('Pasta de dientes'), ('té'), ('Te'), ('tes'),
                   ('Cafés'), (E'café'), ('Reses'), ('Pimientos'), ('pimienta'), ('Melón'), ('melones'), ('kiwi'),
                   ('JALAPEÑOS'), ('jalapenos'), ('Champu'), ('ñames'), ('tortilla'), ('Huevo'), ('egg'), ('Manzana'),
                   (E'le​che'), (E' leche '), ('pan'), ('red'), ('tuna'), ('gas'), ('yes'), ('es'), ('s'), ('ss'),
                   ('eses'), ('7up'), ('12345'), (repeat('milk', 15)), ('zorblax'), ('Zorblaxes')) e (n)) p
cross join (values ('en'), ('es')) x (l)
union all
select e.n, x.l, pg_temp.food_other_v0(e.n, x.l)
from (values (''), ('   '), (E'\t\n'), (null), ('zorblax'), ('Leche'), ('MILK'), ('Tortillas'), ('Melon'), ('papeles')) e (n)
cross join (values ('en'), ('es'), ('fr'), (null)) x (l);
select test.is((select string_agg(format('%s in %s: %s, was %s', coalesce(c.n, 'null'), coalesce(c.l, 'null'),
                                         coalesce(c.got, 'null'), coalesce(c.was, 'null')), '; ')
                from (select w.n, w.l, w.was, private.food_other(w.n, w.l) as got from food_was w) c
                where c.got is distinct from c.was),
               null, 'food_other, a lookup in food_pairs, answers exactly as the old food_other did');
select test.ok((select count(distinct n) from food_was) > 1500 and (select count(was) from food_was) > 1000,
               '... on more than 1500 names, more than 1000 times with an answer');
select test.is((select count(*) from private.food_pairs), (select 2 * count(es) from private.food_words()),
               'food_pairs: each pair in food_words, both ways (a migration that changes food_words fills it again)');

-- ---------------------------------------------------------------------
-- The list, signed in (§4)
-- ---------------------------------------------------------------------
-- Amounts: each text added and undone at once, on an empty list.
:as_admin
select test.is(pg_temp.parse(t), want, 'add "' || regexp_replace(t, '[^ -~À-ÿ]', '?', 'g') || '": ' || want)
from (values ('2 milk', 'milk | 2 | dairy'), ('2x milk', 'milk | 2 | dairy'), ('2 x milk', 'milk | 2 | dairy'),
             ('12 huevos', 'huevos | 12 | dairy'), ('2 lb ground beef', 'ground beef | 2 lb | meat'), ('1 dozen eggs', 'eggs | 1 dozen | dairy'),
             ('3 cans of black beans', 'black beans | 3 cans | pantry'), ('2 bolsas de arroz', 'arroz | 2 bolsas | pantry'),
             ('2% milk', '2% milk | - | dairy'), ('7up', '7up | - | other'), ('7 Up', '7 Up | - | other'),
             ('Milk: 2 gallons', 'Milk | 2 gallons | dairy'), ('2 ñames', 'ñames | 2 | other'),
             (E'  Oat\u200b \u202emilk\n', 'Oat milk | - | dairy')) v (t, want);
select test.is((select count(*) from shopping_items), 0::bigint, '... (each of those was undone)');
select test.throws($$select add_to_list(null)$$, 'Type what to buy.', 'add: nothing typed → 22023');
select test.throws($$select add_to_list(E' \u200b ')$$, 'Type what to buy.', '... nor only invisible characters');
select test.throws($$select add_to_list(': 2 gallons')$$, 'Type what to buy.', '... nor only a note');
select test.is((pg_temp.parse(repeat('x', 5000)) like repeat('x', 60) || ' | - | other'), true, 'a long name is cut to 60 characters');

:as_owner
set hub.now = '2026-10-27 09:15:30.123456 America/New_York';
:as_admin
select test.is(add_to_list('Milk') - 'to_buy' - 'bought' - 'as_of' - 'item_id', '{"result": "added", "name": "Milk"}'::jsonb,
               'add_to_list: a new line → added, with its name');
select test.is((select concat_ws(' ', added_by = test.person('Alex'), added_at = private.now(), aisle, private, bought_at, updated_by)
                from shopping_items where name = 'Milk'), 't t dairy f alex@example.com',
               '... added now by Alex (the caller''s person), in Dairy & eggs, to buy, stamped with the email');
select test.is((select (r ->> 'item_id')::uuid = (pg_temp.line('Milk')).id and r ? 'to_buy' and r ? 'bought' and r ? 'as_of'
                from (select add_to_list('Milk') as r) x), true, '... the reply has the line''s id and the list (shopping_list)');
select test.is(add_to_list(' MILK ') - 'to_buy' - 'bought' - 'as_of' - 'item_id', '{"result": "already", "name": "Milk"}'::jsonb,
               '" MILK " is the same line: already, with the line''s name');
select test.is((select count(*) from shopping_items), 1::bigint, '... one row');
select test.is(add_to_list('Milk: 2 gallons') ->> 'result', 'already', 'a note for a line to buy: already');
select test.is((pg_temp.line('Milk')).note, '2 gallons', '... the note is added');
select test.is(add_to_list('2 milk') ->> 'result', 'already', 'a second note');
select test.is((pg_temp.line('Milk')).note, '2 gallons · 2', '... joins after " · "');
:as_owner
create temp table before as select xmin::text as x, * from shopping_items where name = 'Milk';
:as_admin
select test.is(add_to_list('2 milk') ->> 'result', 'already', 'the same add again (a resend after a lost reply): already');
:as_owner
select test.is((select xmin::text = (select x from before) from shopping_items where name = 'Milk'), true, '... and nothing is written');
drop table before;
:as_admin
select test.is(add_to_list('Leche') - 'to_buy' - 'bought' - 'as_of', jsonb_build_object('result', 'already', 'item_id', (pg_temp.line('Milk')).id, 'name', 'Milk'),
               '"Leche" while "Milk" is to buy: that line (already, "Milk")');
select test.is((select count(*) from shopping_items), 1::bigint, '... still one row');
select test.is(pg_temp.el(shopping_list(), 'to_buy', 'Milk') - 'id' - 'seen' - 'added_by',
               '{"name": "Milk", "note": "2 gallons · 2", "aisle": "dairy", "private": false}'::jsonb,
               'shopping_list: a line to buy (no "other": Milk is English and so is Alex)');

-- The lock.
select test.is(add_to_list('Pregnancy test', true) ->> 'result', 'added', 'a locked line');
select test.is((pg_temp.line('Pregnancy test', true)).private, true, '... is locked');
select test.is(add_to_list('pregnancy test') ->> 'item_id', (pg_temp.line('Pregnancy test', true)).id::text,
               'lock off, only a locked line with the name: that line');
select test.is((select count(*) || ' ' || bool_and(private) from shopping_items where name_key = 'pregnancy test'), '1 true',
               '... still locked (a re-add never unlocks)');
select add_to_list('Soap');
select test.is(add_to_list('soap', true) ->> 'item_id', (pg_temp.line('Soap')).id::text, 'lock on, only an unlocked line: that line');
select test.is((select count(*) || ' ' || bool_and(private) from shopping_items where name_key = 'soap'), '1 true', '... which becomes locked');

-- Ticking against the state the phone saw.
select (x ->> 'id') as milk, (x ->> 'seen') as milk_seen0 from pg_temp.el(shopping_list(), 'to_buy', 'Milk') x \gset
select test.is((:'milk_seen0')::timestamptz, (pg_temp.line('Milk')).added_at, 'seen round-trips through the JSON text to the same instant');
select test.ok(:'milk_seen0' like '%:30.123456%', '... microseconds kept');
:as_owner
set hub.now = '2026-10-27 09:20 America/New_York';
:as_admin
select test.is(buy_item(:'milk', true, :'milk_seen0') ->> 'changed', 'true', 'buy with the seen of the line to buy: changed');
select test.is((select concat_ws(' ', bought_at = private.now(), bought_by = test.person('Alex')) from shopping_items where name = 'Milk'), 't t',
               '... bought now, by Alex');
select test.is(buy_item(:'milk', true, :'milk_seen0') ->> 'changed', 'false', 'a second buy (another phone, or a resend): false');
select (x ->> 'seen') as milk_bought1 from pg_temp.el(shopping_list(), 'bought', 'Milk') x \gset
:as_owner
set hub.now = '2026-10-27 09:40 America/New_York';
:as_adult
select test.is(buy_item(:'milk', false, :'milk_bought1') ->> 'changed', 'true', 'Sam puts it back on the list 20 minutes later');
select test.is((select concat_ws(' ', bought_at, bought_by, added_at = private.now(), added_by = test.person('Sam')) from shopping_items where name = 'Milk'),
               't t', '... after 15 minutes that is going back on the list: added now, by Sam');
:as_admin
select test.is(buy_item(:'milk', true, :'milk_seen0') ->> 'changed', 'false',
               'a buy whose seen is from before the put-back (it waited offline): false');
select test.is((pg_temp.line('Milk')).bought_at, null, '... the line stays to buy');
select (x ->> 'seen') as milk_seen2 from pg_temp.el(shopping_list(), 'to_buy', 'Milk') x \gset
:as_owner
set hub.now = '2026-10-27 09:45 America/New_York';
:as_admin
select test.is(buy_item(:'milk', true, :'milk_seen2') ->> 'changed', 'true', 'Alex buys it again');
select test.is(buy_item(:'milk', false, :'milk_bought1') ->> 'changed', 'false',
               'a put-back whose seen is from before someone else''s later buy: false');
select test.ok((pg_temp.line('Milk')).bought_at is not null, '... still bought');
select (x ->> 'seen') as milk_bought3 from pg_temp.el(shopping_list(), 'bought', 'Milk') x \gset
:as_owner
set hub.now = '2026-10-27 09:50 America/New_York';
:as_admin
select test.is(buy_item(:'milk', false, :'milk_bought3') ->> 'changed', 'true', 'Undo 5 minutes after the buy');
select test.is((select concat_ws(' ', bought_at, added_at = :'milk_seen2'::timestamptz, added_by = test.person('Sam')) from shopping_items where name = 'Milk'),
               't t', '... within 15 minutes it''s an Undo: added_at and added_by stay');
select test.is(buy_item(gen_random_uuid(), true, now()) ->> 'changed', 'false', 'an unknown id: false');
select test.throws(format('select buy_item(%L, true, null)', :'milk'), 'Reload the list to see it as it is now.', 'no seen → 22023');
select test.throws(format('select buy_item(%L, null, now())', :'milk'), 'Choose bought or not.', 'neither bought nor not → 22023');
select test.is(test.try(format('select buy_item(%L, true, null)', :'milk')), 'error: Reload the list to see it as it is now.', '... a plain error (22023), not a refusal');

-- Back on the list, with its corrected aisle.
select test.is(add_to_list('Detergent') ->> 'result', 'added', 'Detergent');
select test.is((pg_temp.line('Detergent')).aisle, 'household', '... guessed: Household');
:as_adult
update shopping_items set aisle = 'personal' where name = 'Detergent';
select test.is(buy_item((pg_temp.line('Detergent')).id, true, (pg_temp.line('Detergent')).added_at) ->> 'changed', 'true', 'Sam corrects its aisle and buys it');
:as_owner
set hub.now = '2026-10-28 18:00 America/New_York';
:as_admin
select test.is(add_to_list('detergent: big pack') - 'to_buy' - 'bought' - 'as_of' - 'item_id', '{"result": "back", "name": "Detergent"}'::jsonb,
               'bought, then added again: back, with the line''s name');
select test.is((select concat_ws(' ', bought_at, bought_by, added_at = private.now(), added_by = test.person('Alex'), note, aisle) from shopping_items
                where name = 'Detergent'), 't t big pack personal',
               '... to buy again, added now by Alex, with the new note and the corrected aisle (a correction sticks)');
select (x ->> 'seen') as milk_seen4 from pg_temp.el(shopping_list(), 'to_buy', 'Milk') x \gset
select buy_item(:'milk', true, :'milk_seen4');
select test.is(add_to_list('Leche') - 'to_buy' - 'bought' - 'as_of' - 'item_id', '{"result": "added", "name": "Leche"}'::jsonb,
               '"Leche" while "Milk" is only bought: a new line (a bought twin isn''t brought back)');
select test.is(pg_temp.el(shopping_list(), 'to_buy', 'Leche') ->> 'other', 'milk', 'shopping_list: "other" for "Leche" read by Alex is "milk"');
:as_owner
update people set language = 'es' where name = 'Sam';
:as_adult
select test.is(pg_temp.el(shopping_list(), 'to_buy', 'Detergent') ->> 'other', 'detergente', '... in the reader''s language (Sam reads Spanish now)');
:as_owner
update people set language = 'en' where name = 'Sam';

-- Editing and forgetting: name, note, aisle and lock only; a clash says so (23505).
:as_admin
select add_to_list('Milk 2');
select test.throws($$update shopping_items set name = 'MILK' where name = 'Milk 2'$$, 'duplicate key value',
                   'a rename to a name another line has, with the same lock: 23505');
:as_owner
insert into shopping_items (name) values ('Pregnancy test');
:as_admin
select test.throws($$update shopping_items set private = true where name = 'Pregnancy test' and not private$$, 'duplicate key value',
                   'locking a line when a locked line has its name: 23505');
select test.is(test.try($$update shopping_items set name = E'Oat\u200b milk ', note = E'big\npack', aisle = 'dairy', private = true where name = 'Milk 2'$$),
               'rows:1', 'members change a line''s name, note, aisle and lock');
update shopping_items set name = E'Oat\u200b milk ', note = E'big\npack', aisle = 'dairy', private = true where name = 'Milk 2';
select test.is((select concat_ws(' | ', name, note, aisle, private) from shopping_items where name_key = 'oat milk'), 'Oat milk | big pack | dairy | t',
               '... cleaned to one line');
update shopping_items set note = '' where name = 'Oat milk';
select test.is((pg_temp.line('Oat milk', true)).note, null, 'an emptied note is none');
select test.throws($$update shopping_items set name = E'\u200b' where name = 'Oat milk'$$, 'violates check constraint', 'a name can''t be emptied');
select test.is(test.try($$update shopping_items set bought_at = now(), bought_by = test.person('Alex')$$), 'denied', 'members cannot set bought_* directly');
select test.is(test.try($$update shopping_items set added_at = now()$$), 'denied', '... nor added_*');
select test.is(test.try($$update shopping_items set updated_by = 'casey@example.com'$$), 'denied', '... nor updated_by');
select test.is(test.try($$insert into shopping_items (name) values ('Bread')$$), 'denied', '... nor insert (add_to_list does)');
select test.is(test.try($$delete from shopping_items where name = 'Oat milk'$$), 'rows:1', 'Forget: members delete a line');
delete from shopping_items where name = 'Oat milk';

-- Outsiders.
:as_stranger
select test.throws($$select add_to_list('Milk')$$, 'Only the family can change the shopping list.', 'stranger: add_to_list refuses');
select test.is(test.try($$select buy_item(gen_random_uuid(), true, now())$$), 'denied', 'stranger: buy_item refuses (42501)');
select test.is(shopping_list() - 'as_of', '{"to_buy": [], "bought": []}'::jsonb, 'stranger: shopping_list is empty');
:as_removed
select test.is(test.try($$select add_to_list('Milk')$$), 'denied', 'removed member: add_to_list refuses (42501)');
select test.is(test.try($$select buy_item(gen_random_uuid(), true, now())$$), 'denied', 'removed member: buy_item refuses (42501)');
select test.is(shopping_list() - 'as_of', '{"to_buy": [], "bought": []}'::jsonb, 'removed member: shopping_list is empty');

-- The cap: 200 things to buy.
begin;
:as_owner
insert into shopping_items (name) select 'Thing ' || g from generate_series(1, 200 - (select count(*) from shopping_items where bought_at is null)) g;
:as_admin
select test.throws($$select add_to_list('One more')$$, 'The list is full.', 'the 201st thing to buy: 54000');
select test.is(test.try($$select add_to_list('One more')$$), 'error: The list is full.', '... an error, not a refusal');
select test.throws($$select add_to_list('Milk')$$, 'The list is full.', '... a bought line can''t come back either');
select test.is(add_to_list('Leche: 2') ->> 'result', 'already', '... but a note for a line to buy still joins');
-- The polls stay quick at the cap: food_other is a lookup (§3.4), so with 200 lines to buy and 60 to
-- suggest, shopping_list() and My day's list take tens of milliseconds, where they took about a second
-- while food_other worked the word list out on every call. The bound is loose, for slow machines.
:as_owner
insert into shopping_items (name, bought_at, bought_by)
select 'Bought ' || g, private.now() - g * interval '1 hour', test.person('Sam') from generate_series(1, 60) g;
update household set helper_list = 'add';
select count(*) as unlocked from shopping_items where bought_at is null and not private \gset
:as_admin
select test.is(case when x.ms < 250 then 'under 250 ms' else x.ms || ' ms' end, 'under 250 ms', 'at the cap, shopping_list() answers in under 250 ms')
from (select pg_temp.ms('select public.shopping_list()') as ms) x;
:as_anon
select test.is(case when x.ms < 250 then 'under 250 ms' else x.ms || ' ms' end, 'under 250 ms',
               '... and My day''s list, with 60 to suggest too')
from (select pg_temp.ms(format('select public.get_list_by_token(%L)', test.token('Morgan'))) as ms) x;
select test.is((select jsonb_array_length(r -> 'items') || ' ' || jsonb_array_length(r -> 'suggest')
                from (select get_list_by_token(test.token('Morgan')) as r) x), :'unlocked' || ' 60',
               '... (every unlocked line to buy, and 60 to suggest)');
rollback;

-- shopping_list(): to buy A–Z; bought since the household's midnight, the latest first.
begin;
:as_owner
delete from shopping_items;
set hub.now = '2026-10-27 18:00:00.25 America/New_York';
insert into shopping_items (name, private, added_by) values
  ('carrots', false, test.person('Alex')), ('Bananas', false, test.person('Alex')), ('apples', false, test.person('Alex')),
  ('apples', true, test.person('Alex')), ('Zucchini', false, test.person('Alex')), ('Leche', false, test.person('Morgan'));
insert into shopping_items (name, bought_at, bought_by) values
  ('Bread', '2026-10-26 23:59:59 America/New_York', test.person('Sam')),
  ('Rice', '2026-10-27 00:00 America/New_York', test.person('Sam'));
:as_admin
select buy_item((pg_temp.line(n, p)).id, true, (pg_temp.line(n, p)).added_at)
from (values ('carrots', false), ('apples', true), ('Bananas', false), ('apples', false)) v (n, p);
select test.is(pg_temp.names(shopping_list(), 'to_buy'), 'Leche, Zucchini', 'shopping_list: to buy, A–Z');
select test.is(pg_temp.names(shopping_list(), 'bought'), 'apples, apples, Bananas, carrots, Rice',
               '... bought: everything since the household''s midnight (not 23:59 the day before), the latest first, then A–Z');
select test.ok((select (r -> 'bought' -> 0 ->> 'id') < (r -> 'bought' -> 1 ->> 'id') from (select shopping_list() as r) x),
               '... two buys at the same time with the same name: by id');
select test.is(pg_temp.el(shopping_list(), 'bought', 'Rice') - 'id',
               jsonb_build_object('name', 'Rice', 'note', null, 'aisle', 'other', 'private', false, 'bought_by', test.person('Sam'),
                                  'seen', '2026-10-27T04:00:00+00:00'),
               '... a bought line: who bought it (an id) and seen = bought_at');
select test.is(pg_temp.el(shopping_list(), 'to_buy', 'Leche') - 'id' - 'seen',
               jsonb_build_object('name', 'Leche', 'note', null, 'aisle', 'other', 'private', false, 'added_by', test.person('Morgan'), 'other', 'milk'),
               '... a line to buy: who added it (an id), and "other" for a known word');
select test.is(shopping_list() ->> 'as_of', '2026-10-27T18:00', '... as_of: the household''s local date and time');
rollback;

-- Two phones add the same thing at the same moment: one line, both notes.
select exists (select 1 from pg_available_extensions where name = 'dblink') as have_dblink \gset
\if :have_dblink
:as_owner
create extension dblink schema test;
select test.dblink_connect('other', format('host=%s port=%s dbname=%s user=postgres', current_setting('unix_socket_directories'),
                                           current_setting('port'), current_database()));
select test.dblink_exec('other', format('set hub.now = %L', current_setting('hub.now')));
select test.dblink_exec('other', $$set request.jwt.claims = '{"role": "authenticated", "email": "sam@example.com"}'$$);
select test.dblink_exec('other', 'set role authenticated');
begin;
:as_admin
select test.is(add_to_list('2 oat milk') ->> 'result', 'added', 'two phones: Alex adds "2 oat milk" (not yet committed)');
:as_owner
select test.dblink_send_query('other', $$select public.add_to_list('3 oat milk')::text$$);
do $$
begin
  for i in 1 .. 200 loop
    exit when exists (select 1 from pg_stat_activity
                      where pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%3 oat milk%');
    perform pg_sleep(0.05);
  end loop;
end;
$$;
select test.ok(exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%3 oat milk%'),
               '... Sam''s "3 oat milk" waits for it');
commit;
select test.is((select r::jsonb ->> 'result' from test.dblink_get_result('other') as t (r text)), 'already',
               '... and, once Alex''s is in, finds that line: already');
select test.is((select count(*) || ' ' || string_agg(note, ',') from shopping_items where name_key = 'oat milk'), '1 2 · 3',
               '... one line, with both notes');
select test.dblink_disconnect('other');
\else
do $$ begin raise notice 'SKIP  two phones at once: the dblink extension isn''t installed'; end $$;
\endif

-- ---------------------------------------------------------------------
-- The list on My day (§3.3, §3.4, §4, §7.2, §12)
-- ---------------------------------------------------------------------
:as_owner
delete from shopping_items;
set hub.now = '2026-10-28 10:00 America/New_York';
insert into shopping_items (name, note, aisle, private, added_at, added_by, bought_at, bought_by) values
  ('Milk', null, 'dairy', false, '2026-10-28 08:00 America/New_York', test.person('Alex'), null, null),
  ('Eggs', '12', 'dairy', false, '2026-10-28 08:01 America/New_York', test.person('Alex'), null, null),
  ('Pregnancy test', 'Brand X', 'personal', true, '2026-10-27 12:00 America/New_York', test.person('Alex'), null, null),
  ('Vitamins', null, 'personal', true, '2026-10-20 12:00 America/New_York', test.person('Alex'), '2026-10-28 09:00 America/New_York', test.person('Alex')),
  ('Butter', null, 'dairy', false, '2026-10-27 12:00 America/New_York', test.person('Alex'), '2026-10-28 08:30 America/New_York', test.person('Alex')),
  ('Coffee', null, 'drinks', false, '2026-10-01 12:00 America/New_York', test.person('Alex'), '2026-10-18 12:00 America/New_York', test.person('Sam')),
  ('Flour', null, 'pantry', false, '2026-09-01 12:00 America/New_York', test.person('Alex'), '2026-09-27 12:00 America/New_York', test.person('Sam'));
create temp table locked as select id, note, added_at, added_by, bought_at, bought_by, updated_at from shopping_items where private;
create temp table people_seen as select id, name from people;
grant select on locked, people_seen to public;

:as_anon
select test.is(get_list_by_token(test.token('Morgan')) - 'items' - 'bought' - 'suggest',
               '{"language": "es", "as_of": "2026-10-28T10:00", "can_add": true}'::jsonb,
               'get_list_by_token (Morgan, the helper): her language, the household''s local date and time, can_add');
select test.is(pg_temp.names(get_list_by_token(test.token('Morgan')), 'items'), 'Eggs, Milk', '... the unlocked lines to buy, A–Z');
select test.is(pg_temp.el(get_list_by_token(test.token('Morgan')), 'items', 'Milk') - 'id' - 'seen',
               '{"name": "Milk", "note": null, "aisle": "dairy", "other": "leche"}'::jsonb, '... each with its note, aisle and her word for it');
select test.is(pg_temp.el(get_list_by_token(test.token('Morgan')), 'items', 'Milk') ->> 'seen', '2026-10-28T12:00:00+00:00', '... and seen (added_at)');
select test.is(get_list_by_token(test.token('Morgan')) -> 'bought',
               jsonb_build_array(jsonb_build_object('id', (pg_temp.line('Butter')).id, 'name', 'Butter', 'note', null, 'aisle', 'dairy',
                                                    'seen', '2026-10-28T12:30:00+00:00', 'undo', false)),
               '... bought today (not the locked Vitamins), with undo false for someone else''s tick');
select test.is(get_list_by_token(test.token('Morgan')) -> 'suggest',
               '[{"name": "Butter", "aisle": "dairy", "other": "mantequilla"}, {"name": "Coffee", "aisle": "drinks", "other": "café"}]'::jsonb,
               '... suggest: unlocked names bought in the last 30 days, the latest first; not locked, not to buy, not older (Flour)');
select test.ok((select not exists (select 1 from locked l where position(l.id::text in r::text) > 0)
                       and position('Pregnancy' in r::text) = 0 and position('Vitamins' in r::text) = 0
                from (select get_list_by_token(test.token('Morgan')) as r) x), '... nothing locked, anywhere in the answer');
select test.ok((select not exists (select 1 from people_seen p where position(p.id::text in r::text) > 0 or position(p.name in r::text) > 0)
                from (select get_list_by_token(test.token('Morgan')) as r) x), '... no names or ids of family members');

-- Who gets it.
select test.is(get_list_by_token(t), null, 'get_list_by_token: ' || why || ' → null')
from (values (repeat('0', 32), 'an unknown token'), ('not-a-token', 'a malformed token'), (null, 'no token (a body of {})'),
             (test.token('Taylor'), 'a kid''s token'), (test.token('Alex'), 'a grown-up''s token')) v (t, why);
select test.is(add_to_list_by_token(t, 'Milk'), null, 'add_to_list_by_token: ' || why || ' → null')
from (values (repeat('0', 32), 'an unknown token'), ('not-a-token', 'a malformed token'), (null, 'no token')) v (t, why);
select test.is(buy_item_by_token(t, (pg_temp.line('Milk')).id, true, (pg_temp.line('Milk')).added_at), null, 'buy_item_by_token: ' || why || ' → null')
from (values (repeat('0', 32), 'an unknown token'), ('not-a-token', 'a malformed token'), (null, 'no token')) v (t, why);
select test.throws(format('select add_to_list_by_token(%L, %L)', test.token(n), 'Milk'), 'The shopping list isn''t on your My day.',
                   'add_to_list_by_token: ' || n || '''s token → 42501')
from (values ('Taylor'), ('Alex')) v (n);
select test.throws(format('select buy_item_by_token(%L, %L, true, %L)', test.token(n), (pg_temp.line('Milk')).id, (pg_temp.line('Milk')).added_at),
                   'The shopping list isn''t on your My day.', 'buy_item_by_token: ' || n || '''s token → 42501')
from (values ('Taylor'), ('Alex')) v (n);
select test.is(test.try(format('select add_to_list_by_token(%L, %L)', test.token('Taylor'), 'Milk')), 'denied', '... a refusal (42501)');
begin;
:as_owner
update people set active = false where name = 'Morgan';
:as_anon
select test.is(concat_ws(' ', get_list_by_token(test.token('Morgan')), add_to_list_by_token(test.token('Morgan'), 'Milk'),
                         buy_item_by_token(test.token('Morgan'), (pg_temp.line('Milk')).id, true, (pg_temp.line('Milk')).added_at)), '',
               'someone no longer on the family list: null from all three');
rollback;

-- The switch: Off, See and tick, See, tick and add.
begin;
:as_owner
update household set helper_list = 'off';
:as_anon
select test.is(get_list_by_token(test.token('Morgan')), null, 'helper_list off: no list');
select test.throws(format('select add_to_list_by_token(%L, %L)', test.token('Morgan'), 'Milk'), 'The shopping list isn''t on your My day.', '... no adds');
select test.throws(format('select buy_item_by_token(%L, %L, true, %L)', test.token('Morgan'), (pg_temp.line('Milk')).id, (pg_temp.line('Milk')).added_at),
                   'The shopping list isn''t on your My day.', '... no ticks');
select test.is(get_person_day(test.token('Morgan')) ? 'list', false, '... and no button on her My day');
:as_owner
update household set helper_list = 'see';
:as_anon
select test.is((select (r ->> 'can_add') || ' ' || (r ? 'suggest') from (select get_list_by_token(test.token('Morgan')) as r) x), 'false false',
               'helper_list see: the list, without can_add or suggest');
select test.throws(format('select add_to_list_by_token(%L, %L)', test.token('Morgan'), 'Milk'), 'You can''t add to the list from My day.', '... no adds (42501)');
select test.is(buy_item_by_token(test.token('Morgan'), (pg_temp.line('Milk')).id, true, (pg_temp.line('Milk')).added_at) ->> 'changed', 'true', '... ticks');
select test.is(get_person_day(test.token('Morgan')) -> 'list', '{"to_buy": 1}'::jsonb, '... and the button, with how many unlocked things are to buy');
rollback;
:as_anon
select test.is(get_person_day(test.token('Morgan')) -> 'list', '{"to_buy": 2}'::jsonb, 'helper_list add: the button on her My day ("Lista de compras · 2")');
select test.is(get_person_day(test.token('Taylor')) ? 'list', false, '... never on a kid''s');
select test.is(get_person_day(test.token('Alex')) ? 'list', false, '... nor a grown-up''s');

-- What she types.
select test.throws(format('select add_to_list_by_token(%L, null)', test.token('Morgan')), 'Type what to buy.', 'add_to_list_by_token: nothing typed → 22023');
select test.throws(format('select add_to_list_by_token(%L, %L)', test.token('Morgan'), repeat('a', 201)), 'That''s too long to add.',
                   'a 201-character name → 22023');
select test.is(pg_temp.used('2026-10-28'), 'none', '... refused before anything is counted');
select test.is(add_to_list_by_token(test.token('Morgan'), '<img src=x onerror=alert(1)>') - 'items' - 'bought' - 'suggest' - 'item_id',
               '{"result": "added", "name": "<img src=x onerror=alert(1)>", "language": "es", "as_of": "2026-10-28T10:00", "can_add": true}'::jsonb,
               'a hostile name is stored as text; the reply has the result and her list');
select test.is((select concat_ws(' | ', l.name, l.private, l.added_by = test.person('Morgan'), l.updated_by) from pg_temp.line('<img src=x onerror=alert(1)>') l),
               '<img src=x onerror=alert(1)> | f | t | Morgan (My day)', '... unlocked, added by her, updated_by "Morgan (My day)"');
select test.is(pg_temp.used('2026-10-28'), '1 0', '... one change counted');
select test.is(add_to_list_by_token(test.token('Morgan'), 'Leche') - 'items' - 'bought' - 'suggest' - 'language' - 'as_of' - 'can_add',
               jsonb_build_object('result', 'already', 'item_id', (pg_temp.line('Milk')).id, 'name', 'Milk'),
               '"Leche" while "Milk" is to buy: "Ya está en la lista como Milk"');
select test.is(pg_temp.used('2026-10-28'), '1 0', '... nothing changed, nothing counted');

-- The lock: nothing typed on her link finds, changes or names a locked line.
select test.is((select (r ->> 'result') || ' ' || ((r ->> 'item_id')::uuid in (select id from locked)) || ' ' || (r ->> 'name')
                from (select add_to_list_by_token(test.token('Morgan'), 'pregnancy test') as r) x), 'added false pregnancy test',
               'her "pregnancy test" while a locked "Pregnancy test" is to buy: a new, visible line of her own');
select test.is((select (r ->> 'result') || ' ' || ((r ->> 'item_id')::uuid in (select id from locked))
                from (select add_to_list_by_token(test.token('Morgan'), 'Vitamins: 2') as r) x), 'added false',
               '... and her "Vitamins" while a locked one is bought: a new line, not the locked one back');
select test.is((select count(*) from pg_temp.line('Pregnancy test', true) s join locked l on l.id = s.id
                where (s.note, s.added_at, s.added_by, s.bought_at, s.bought_by, s.updated_at) is not distinct from
                      (l.note, l.added_at, l.added_by, l.bought_at, l.bought_by, l.updated_at))
               + (select count(*) from pg_temp.line('Vitamins', true) s join locked l on l.id = s.id
                where (s.note, s.added_at, s.added_by, s.bought_at, s.bought_by, s.updated_at) is not distinct from
                      (l.note, l.added_at, l.added_by, l.bought_at, l.bought_by, l.updated_at)), 2::bigint,
               '... the locked lines'' note, added_at, added_by, bought_at and bought_by are unchanged');
select test.is(buy_item_by_token(test.token('Morgan'), (select id from locked where bought_at is null), true,
                                 (select added_at from locked where bought_at is null)) ->> 'changed', 'false',
               'a tick of a locked line, with its right seen: false, as for an unknown id');
select test.is(buy_item_by_token(test.token('Morgan'), (select id from locked where bought_at is not null), false,
                                 (select bought_at from locked where bought_at is not null)) ->> 'changed', 'false',
               'an Undo of a locked line someone else bought: false, as for an unknown id (not "only your own tick")');
select test.is(buy_item_by_token(test.token('Morgan'), gen_random_uuid(), true, now()) ->> 'changed', 'false', '... an unknown id: false');
select test.is((select count(*) from pg_temp.line('Pregnancy test', true) s join locked l on l.id = s.id
                where (s.bought_at, s.bought_by, s.updated_at) is not distinct from (l.bought_at, l.bought_by, l.updated_at))
               + (select count(*) from pg_temp.line('Vitamins', true) s join locked l on l.id = s.id
                where (s.bought_at, s.bought_by, s.updated_at) is not distinct from (l.bought_at, l.bought_by, l.updated_at)), 2::bigint,
               '... and the locked lines stay as they were');
select test.is(pg_temp.used('2026-10-28'), '3 0', '... calls that change nothing aren''t counted');

-- Ticks and Undo.
select (x ->> 'id') as eggs, (x ->> 'seen') as eggs_seen from pg_temp.el(get_list_by_token(test.token('Morgan')), 'items', 'Eggs') x \gset
select test.is((select (r ->> 'changed') || ' ' || pg_temp.names(r, 'items') from (select buy_item_by_token(test.token('Morgan'), :'eggs', true, :'eggs_seen') as r) x),
               'true <img src=x onerror=alert(1)>, Milk, pregnancy test, Vitamins', 'she ticks Eggs: changed, and her list without it');
select test.is(pg_temp.el(get_list_by_token(test.token('Morgan')), 'bought', 'Eggs') - 'id',
               '{"name": "Eggs", "note": "12", "aisle": "dairy", "seen": "2026-10-28T14:00:00+00:00", "undo": true}'::jsonb,
               '... under bought today, with undo (her tick of the last 15 minutes)');
select test.is((select concat_ws(' | ', l.bought_by = test.person('Morgan'), l.updated_by) from pg_temp.line('Eggs') l), 't | Morgan (My day)',
               '... bought by her, updated_by "Morgan (My day)"');
select test.is(buy_item_by_token(test.token('Morgan'), :'eggs', true, :'eggs_seen') ->> 'changed', 'false', 'the same tick again: false (not counted)');
select test.is(pg_temp.used('2026-10-28'), '3 1', '... one tick counted');
:as_owner
set hub.now = '2026-10-28 10:10 America/New_York';
:as_anon
select test.is(buy_item_by_token(test.token('Morgan'), :'eggs', false, '2026-10-28 14:00+00') ->> 'changed', 'true', 'her Undo 10 minutes later');
select test.is((select concat_ws(' ', l.bought_at, l.added_at = '2026-10-28 08:01 America/New_York', l.added_by = test.person('Alex')) from pg_temp.line('Eggs') l),
               't t', '... back to buy, as it was (added_at and added_by stay)');
select test.is(pg_temp.used('2026-10-28'), '3 2', '... an Undo counts as a tick');
select test.throws(format('select buy_item_by_token(%L, %L, false, %L)', test.token('Morgan'), (pg_temp.line('Butter')).id, (pg_temp.line('Butter')).bought_at),
                   'Only your own tick can be undone, for 15 minutes.', 'she can''t undo Alex''s tick (42501)');
select test.is(test.try(format('select buy_item_by_token(%L, %L, false, %L)', test.token('Morgan'), (pg_temp.line('Butter')).id, (pg_temp.line('Butter')).bought_at)),
               'denied', '... a refusal');
select (x ->> 'seen') as eggs_seen from pg_temp.el(get_list_by_token(test.token('Morgan')), 'items', 'Eggs') x \gset
select buy_item_by_token(test.token('Morgan'), :'eggs', true, :'eggs_seen');
:as_owner
set hub.now = '2026-10-28 10:26 America/New_York';
:as_anon
select test.is(pg_temp.el(get_list_by_token(test.token('Morgan')), 'bought', 'Eggs') ->> 'undo', 'false', '16 minutes after her tick: no undo');
select test.throws(format('select buy_item_by_token(%L, %L, false, %L)', test.token('Morgan'), :'eggs', '2026-10-28 14:10+00'),
                   'Only your own tick can be undone, for 15 minutes.', '... and her Undo is refused (42501)');
select test.is(pg_temp.used('2026-10-28'), '3 3', '... refused calls aren''t counted');

-- Midnight: today's buys in the household's zone, and her own tick of 23:55 still undoable at 00:05.
begin;
:as_owner
set hub.now = '2026-11-03 23:50 America/New_York';
insert into shopping_items (name, added_at, added_by) values ('Bread', '2026-11-03 20:00 America/New_York', test.person('Alex')),
                                                         ('Jam', '2026-11-03 20:00 America/New_York', test.person('Alex')),
                                                         ('Late milk', '2026-11-03 20:00 America/New_York', test.person('Alex'));
:as_admin
select buy_item((pg_temp.line('Bread')).id, true, (pg_temp.line('Bread')).added_at);
:as_owner
set hub.now = '2026-11-03 23:55 America/New_York';
:as_anon
select buy_item_by_token(test.token('Morgan'), (pg_temp.line('Late milk')).id, true, (pg_temp.line('Late milk')).added_at);
:as_owner
set hub.now = '2026-11-04 00:01 America/New_York';
:as_admin
select buy_item((pg_temp.line('Jam')).id, true, (pg_temp.line('Jam')).added_at);
:as_owner
set hub.now = '2026-11-04 00:05 America/New_York';
:as_anon
select test.is((select pg_temp.names(r, 'bought') || ' | ' || (pg_temp.el(r, 'bought', 'Jam') ->> 'undo') || ' ' || (pg_temp.el(r, 'bought', 'Late milk') ->> 'undo')
                from (select get_list_by_token(test.token('Morgan')) as r) x), 'Jam, Late milk | false true',
               'at 00:05: bought since midnight (Jam), and her own tick of 23:55 with undo; not Alex''s buy of 23:50');
select test.is(get_list_by_token(test.token('Morgan')) ->> 'as_of', '2026-11-04T00:05', '... as_of is the local date and time');
select test.is(buy_item_by_token(test.token('Morgan'), (pg_temp.line('Late milk')).id, false, (pg_temp.line('Late milk')).bought_at) ->> 'changed', 'true',
               '... and she can still undo it');
rollback;

-- The caps: 30 changes and 100 ticks a day, counted per call.
:as_owner
set hub.now = '2026-10-29 10:00 America/New_York';
:as_anon
do $$
begin
  for i in 1 .. 10 loop    -- 10 new lines
    perform public.add_to_list_by_token(test.token('Morgan'), 'Item ' || lpad(i::text, 2, '0'));
  end loop;
  for i in 1 .. 10 loop    -- 10 notes appended ("already")
    perform public.add_to_list_by_token(test.token('Morgan'), 'Item ' || lpad(i::text, 2, '0') || ': big');
  end loop;
end;
$$;
:as_admin
select count(buy_item(id, true, added_at)) from shopping_items where name like 'Item %';
:as_anon
do $$
begin
  for i in 1 .. 10 loop    -- 10 bought lines back ("back")
    perform public.add_to_list_by_token(test.token('Morgan'), 'Item ' || lpad(i::text, 2, '0'));
  end loop;
end;
$$;
select test.is(pg_temp.used('2026-10-29'), '30 0', 'new lines, notes appended and lines brought back: 30 changes counted');
select test.is(add_to_list_by_token(test.token('Morgan'), 'Item 01') ->> 'result', 'already', 'at the cap, a resend that changes nothing: already');
select test.throws(format('select add_to_list_by_token(%L, %L)', test.token('Morgan'), 'Item 11'), 'Too many changes from My day today.',
                   'the 31st change of the day: P0001');
select test.throws(format('select add_to_list_by_token(%L, %L)', test.token('Morgan'), 'Item 01: small'), 'Too many changes from My day today.',
                   '... a note appended counts too');
select test.is((select coalesce((pg_temp.line('Item 11')).id::text, 'none') || ' ' || coalesce((pg_temp.line('Item 01')).note, 'none')), 'none none',
               '... and changes nothing (no new line, no note: brought back, Item 01 has none)');
select test.is(pg_temp.used('2026-10-29'), '30 0', '... nor its count');
:as_owner
set hub.now = '2026-10-30 10:00 America/New_York';
:as_anon
select test.is(add_to_list_by_token(test.token('Morgan'), 'Item 11') ->> 'result', 'added', 'the next day works');

:as_owner
set hub.now = '2026-11-01 10:00 America/New_York';
insert into shopping_items (name, added_by) values ('Tick me', test.person('Alex'));
:as_anon
do $$
declare
  r  jsonb;
  it jsonb;
begin
  for i in 1 .. 50 loop    -- a tick and an Undo, 50 times
    it := pg_temp.el(public.get_list_by_token(test.token('Morgan')), 'items', 'Tick me');
    r := public.buy_item_by_token(test.token('Morgan'), (it ->> 'id')::uuid, true, (it ->> 'seen')::timestamptz);
    it := pg_temp.el(r, 'bought', 'Tick me');
    r := public.buy_item_by_token(test.token('Morgan'), (it ->> 'id')::uuid, false, (it ->> 'seen')::timestamptz);
  end loop;
end;
$$;
select test.is(pg_temp.used('2026-11-01'), '0 100', '50 ticks and 50 Undos: 100 ticks counted alike');
select test.throws(format('select buy_item_by_token(%L, %L, true, %L)', test.token('Morgan'), (pg_temp.line('Tick me')).id, (pg_temp.line('Tick me')).added_at),
                   'Too many ticks from My day today.', 'the 101st: P0001');
select test.is((pg_temp.line('Tick me')).bought_at, null, '... and nothing is bought');
:as_owner
set hub.now = '2026-11-02 10:00 America/New_York';
:as_anon
select test.is(buy_item_by_token(test.token('Morgan'), (pg_temp.line('Tick me')).id, true, (pg_temp.line('Tick me')).added_at) ->> 'changed', 'true',
               'the next day works');

-- 150 things to buy: her adds stop, the family's don't.
begin;
:as_owner
insert into shopping_items (name) select 'Thing ' || g from generate_series(1, 150 - (select count(*) from shopping_items where bought_at is null)) g;
:as_anon
select test.throws(format('select add_to_list_by_token(%L, %L)', test.token('Morgan'), 'One more'), 'The list is full.', 'at 150 to buy, her add: 54000');
select test.is(pg_temp.used('2026-11-02'), '0 1', '... not counted');
:as_admin
select test.is(add_to_list('One more') ->> 'result', 'added', '... while Alex''s still works');
rollback;
