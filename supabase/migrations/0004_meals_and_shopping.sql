-- =====================================================================
-- HOME HUB v1.2 — migration 0004: Food (dinners and the shopping list)
-- Apply once, after 0003. The build contract is docs/v1.2-kitchen.md
-- (§3 lists everything here; the section numbers below are that file's).
--
-- What it adds
--   • Tables: meals (one row per planned meal; the pages plan dinner only),
--     shopping_items (the shopping list: one row per thing the household buys,
--     kept after it is bought) and my_day_use (what each My day link did to the
--     list today). household gains meals_on_wall and helper_list.
--     calendar_links accepts item_kind 'meal'.
--   • Pages: shopping_list(); signed-in actions add_to_list and buy_item.
--   • My day: get_list_by_token, add_to_list_by_token and buy_item_by_token.
--   • Replaced, with the same signatures: get_person_day and day_text (meals),
--     calendar_plan (past dinners stay on Google). hub_schema_version() returns 4.
--   • Wrapped, so their 0003 bodies run exactly as before: digest_for (its 0003
--     body is now private.digest_for_v3) and private.calendar_desired (now
--     private.calendar_desired_v3). The new ones add the meal rows on top. A later
--     migration that changes either one replaces the wrapper and the _v3 body together.
--
-- Rules
--   • One transaction. It refuses to run without 0003, twice, or on a database
--     that isn't as 0003 left it.
--   • Additive: the v2 pages work the same on 3 and 4.
--   • Every table has row-level security. No rows are seeded: with no meals and no
--     list, the email, the texts, My day and the wall come out byte for byte as on 3.
--   • Three new functions for anon (the token functions); a locked line never
--     appears in, is matched by, or is changed by any of them.
--   • Every time the functions write is private.now(), so the tests can move the clock.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002_home_hub_v2.sql and 0003_google_calendar.sql first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 3 then
    raise exception 'Google Calendar (migration 0003) isn''t installed (hub_schema_version() is %). Run 0003_google_calendar.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 4 then
    raise exception 'Meals and shopping (migration 0004) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  -- A database rolled back as §15 says: before the shape check, so it gets the right message.
  if to_regclass('public.meals') is not null then
    raise exception 'Meals and shopping (migration 0004) is already installed, but hub_schema_version() was set back to 3. To switch it on again, make hub_schema_version() return 4 (docs/v1.2-kitchen.md §15). Nothing was changed.';
  end if;
  -- What this migration renames and widens is as 0003 left it.
  if to_regprocedure('public.digest_for(uuid, date)') is null
     or to_regprocedure('private.calendar_desired(date, date, text)') is null
     or to_regprocedure('private.digest_for_v3(uuid, date)') is not null
     or to_regprocedure('private.calendar_desired_v3(date, date, text)') is not null
     or not exists (select 1 from pg_constraint
                    where conname = 'calendar_links_item_kind_check' and conrelid = to_regclass('public.calendar_links')) then
    raise exception 'This database isn''t as migration 0003 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables (§3.2)
-- ---------------------------------------------------------------------

-- One row per planned meal. v1.2's pages plan dinner only; everything in SQL handles
-- any slot, ordered breakfast, lunch, dinner (array_position, never order by slot).
create table public.meals (
  id         uuid primary key default gen_random_uuid(),
  day        date not null,                     -- the household's day
  slot       text not null default 'dinner' check (slot in ('breakfast', 'lunch', 'dinner')),
  kind       text not null default 'cook' check (kind in ('cook', 'leftovers', 'out', 'takeout', 'fend')),
  title      text check (title is null or char_length(title) between 1 and 80),   -- "Tacos", as typed; null for the quick kinds
  cook_id    uuid references public.people (id) on delete set null,
             -- who cooks (who's on dinner, for leftovers and takeout); optional; an inactive person counts as nobody
  note       text check (note is null or char_length(note) between 1 and 300),   -- for the cook
  link       text check (link is null or (link ~ '^https://[!#-;=?-~]{4,}$' and char_length(link) <= 508)),
             -- a recipe page; https only, printable ASCII only (no spaces, quotes, < >, control, bidi or
             -- zero-width characters), 4 to 500 after "https://" (a regex count stops at 255, hence the
             -- length); the page saves new URL(typed).href, which punycodes and percent-encodes
  private    boolean not null default false,
             -- locked: the title stays off the wall, other people's My day and every email subject
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (day, slot),                           -- the page upserts on (day, slot)
  check ((kind = 'cook') = (title is not null)),
  check (kind = 'cook' or link is null),
  check (kind not in ('out', 'fend') or cook_id is null)
);
create index meals_cook on public.meals (cook_id) where cook_id is not null;

-- The shopping list: one row per thing the household buys (and per lock), kept after it is
-- bought. That row is the item's history, the suggestions as you type, and the guard
-- against duplicates. Members add through add_to_list (no insert policy).
create table public.shopping_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),       -- as first typed, cleaned
  name_key   text generated always as (lower(name)) stored,                   -- "Milk" and "milk " are one item
  note       text check (note is null or char_length(note) between 1 and 80),  -- "2", "big pack", "2 gallons", "2 lb"
  aisle      text not null default 'other'
             check (aisle in ('produce', 'bakery', 'pantry', 'drinks', 'household', 'personal', 'meat', 'dairy', 'frozen', 'other')),
  private    boolean not null default false,
             -- locked: never read, matched or changed through a My day link; every member still sees it
  added_at   timestamptz not null default now(),   -- the last time it was put on the list
  added_by   uuid references public.people (id) on delete set null,   -- who put it on the list last
  bought_at  timestamptz,                          -- null: to buy
  bought_by  uuid references public.people (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by text,                                 -- "<name> (My day)" for My day's writes
  check (bought_at is not null or bought_by is null)
);
-- A locked and an unlocked "Pregnancy test" are two lines, so nothing a My day link types
-- can land on the locked one. A plain index (not partial), so on conflict needs no predicate.
create unique index shopping_items_name_key on public.shopping_items (name_key, private);
create index shopping_items_bought on public.shopping_items (bought_at desc) where bought_at is not null;

-- What each My day link did to the list today (the caps in §4): one row per helper per day
-- she uses the list. Only private.count_my_day writes it, and nothing else reads it.
create table public.my_day_use (
  person_id uuid not null references public.people (id) on delete cascade,
  day       date not null,                        -- the household's day (public.today_local())
  changes   int not null default 0,               -- add calls that changed the list
  ticks     int not null default 0,               -- tick and Undo calls that changed a row
  primary key (person_id, day)
);

-- Two switches for parents (household's policies: members read, admins update).
alter table public.household
  add column meals_on_wall boolean not null default true,   -- meals on Hub – Family (§10)
  add column helper_list   text not null default 'add'
                           check (helper_list in ('off', 'see', 'add'));
                           -- the list on helpers' My day: off, see and tick, or also add

-- calendar_record stores a meal's link, and calendar_store_events adopts one (its adoption
-- catches every error, so without this it would silently skip a meal).
alter table public.calendar_links drop constraint calendar_links_item_kind_check;
alter table public.calendar_links add constraint calendar_links_item_kind_check
  check (item_kind in ('event', 'task', 'project', 'late', 'meal'));

-- ---------------------------------------------------------------------
-- Tidy values
-- ---------------------------------------------------------------------

-- A meal's title and note: one line, no control, bidi or zero-width characters, at most
-- 80 and 300 characters; '' becomes null (so a cooked meal needs a real title).
-- Same-event triggers fire in name order: meals_stamp runs before meals_tidy.
create function private.meals_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := nullif(private.clean_text(new.title, 80), '');
  new.note := nullif(private.clean_text(new.note, 300), '');
  return new;
end;
$$;

-- A line's name and note, the same way, at most 60 and 80 characters; '' note becomes null.
-- name_key is computed after this (a stored generated column follows BEFORE triggers).
create function private.shopping_items_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := private.clean_text(new.name, 60);
  new.note := nullif(private.clean_text(new.note, 80), '');
  return new;
end;
$$;

create trigger meals_stamp before insert or update on public.meals
  for each row execute function private.stamp();
create trigger meals_tidy before insert or update on public.meals
  for each row execute function private.meals_tidy();
create trigger shopping_items_stamp before insert or update on public.shopping_items
  for each row execute function private.stamp();
create trigger shopping_items_tidy before insert or update on public.shopping_items
  for each row execute function private.shopping_items_tidy();

-- ---------------------------------------------------------------------
-- Row-level security and grants (§3.2, §3.3)
-- ---------------------------------------------------------------------
alter table public.meals          enable row level security;
alter table public.shopping_items enable row level security;
alter table public.my_day_use     enable row level security;

create policy "Family manages meals" on public.meals
  for all to authenticated using (private.is_member()) with check (private.is_member());

-- No insert policy: adds go through add_to_list (and My day's add_to_list_by_token).
create policy "Family can see the shopping list" on public.shopping_items
  for select to authenticated using (private.is_member());
create policy "Family changes the shopping list" on public.shopping_items
  for update to authenticated using (private.is_member()) with check (private.is_member());
create policy "Family removes from the shopping list" on public.shopping_items
  for delete to authenticated using (private.is_member());

-- my_day_use: no policies.

-- Supabase's default privileges give anon and authenticated everything on a new table
-- (truncate ignores row-level security). Anon gets nothing; members get what the pages
-- need: meals' own columns, and on shopping_items the four a grown-up edits (never
-- added_* or bought_*). service_role keeps the defaults on meals and shopping_items
-- (digest_for and the calendar job read them); my_day_use is for its owner only.
revoke all on public.meals, public.shopping_items, public.my_day_use from public, anon, authenticated;
revoke all on public.my_day_use from service_role;
grant select, delete on public.meals to authenticated;
grant insert (day, slot, kind, title, cook_id, note, link, private), update (day, slot, kind, title, cook_id, note, link, private)
  on public.meals to authenticated;
grant select, delete on public.shopping_items to authenticated;
grant update (name, note, aisle, private) on public.shopping_items to authenticated;

-- ---------------------------------------------------------------------
-- Words (§3.4, §7.4)
-- ---------------------------------------------------------------------

-- v1.2's fixed words in English and Spanish. Anything else falls back to
-- private.calendar_word, and so to private.word (both left as they are).
create function private.food_word(p_key text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(w -> p_lang ->> p_key, w -> 'en' ->> p_key, private.calendar_word(p_key, p_lang))
  from (select '{
    "en": {
      "breakfast": "Breakfast", "lunch": "Lunch", "dinner": "Dinner",
      "leftovers": "Leftovers", "out": "Eating out", "takeout": "Takeout", "fend": "Fend for yourself",
      "cooks": "{name} cooks", "you_cook": "You cook",
      "on_dinner": "{name}''s on dinner", "you_on_dinner": "You''re on dinner"
    },
    "es": {
      "breakfast": "Desayuno", "lunch": "Almuerzo", "dinner": "Cena",
      "leftovers": "Sobras", "out": "Comemos fuera", "takeout": "Comida para llevar", "fend": "Cada uno se arregla",
      "cooks": "Cocina {name}", "you_cook": "Cocinas tú",
      "on_dinner": "{name} se encarga de la cena", "you_on_dinner": "Te encargas tú"
    }
  }'::jsonb as w) dictionary;
$$;

-- The one built-in word list: everyday things as English/Spanish pairs with their aisle.
-- A pair both guesses an aisle and makes "Leche" the same line as "Milk" (whole names only).
-- Words that mean something else in the other language are left out ("pan", "red", "once",
-- "tuna", "pastel"); where the only Spanish word is one of those, the English word keeps its
-- aisle with no Spanish twin (es null). Plurals as they are usually written; a trailing "s" or
-- "es" is tried on both sides when matching (private.guess_aisle, private.food_other).
create function private.food_words()
returns table (en text, es text, aisle text)
language sql
immutable
set search_path = ''
as $$
  select w.en, w.es, w.aisle
  from (values
    -- Produce
    ('apples', 'manzanas', 'produce'), ('bananas', 'plátanos', 'produce'), ('oranges', 'naranjas', 'produce'),
    ('lemons', 'limones', 'produce'), ('limes', 'limas', 'produce'), ('grapes', 'uvas', 'produce'),
    ('strawberries', 'fresas', 'produce'), ('blueberries', 'arándanos', 'produce'), ('raspberries', 'frambuesas', 'produce'),
    ('pears', 'peras', 'produce'), ('peaches', 'duraznos', 'produce'), ('plums', 'ciruelas', 'produce'),
    ('cherries', 'cerezas', 'produce'), ('pineapple', 'piña', 'produce'), ('watermelon', 'sandía', 'produce'),
    ('melon', 'melón', 'produce'), ('mangos', 'mangos', 'produce'), ('kiwis', 'kiwis', 'produce'),
    ('coconut', 'coco', 'produce'), ('avocados', 'aguacates', 'produce'), ('tomatoes', 'tomates', 'produce'),
    ('potatoes', 'papas', 'produce'), ('onions', 'cebollas', 'produce'), ('garlic', 'ajo', 'produce'),
    ('carrots', 'zanahorias', 'produce'), ('lettuce', 'lechuga', 'produce'), ('spinach', 'espinacas', 'produce'),
    ('broccoli', 'brócoli', 'produce'), ('cauliflower', 'coliflor', 'produce'), ('cabbage', 'repollo', 'produce'),
    ('cucumbers', 'pepinos', 'produce'), ('peppers', 'pimientos', 'produce'), ('celery', 'apio', 'produce'),
    ('corn', 'elote', 'produce'), ('mushrooms', 'champiñones', 'produce'), ('zucchini', 'calabacitas', 'produce'),
    ('radishes', 'rábanos', 'produce'), ('asparagus', 'espárragos', 'produce'), ('cilantro', 'cilantro', 'produce'),
    ('parsley', 'perejil', 'produce'), ('basil', 'albahaca', 'produce'), ('ginger', 'jengibre', 'produce'),
    ('jalapeños', 'jalapeños', 'produce'), ('salad', 'ensalada', 'produce'),
    -- Bakery
    ('bread', null, 'bakery'), ('cake', null, 'bakery'), ('tortillas', 'tortillas', 'bakery'),
    ('rolls', 'bolillos', 'bakery'), ('donuts', 'donas', 'bakery'), ('muffins', 'panquecitos', 'bakery'),
    ('baguette', 'baguette', 'bakery'),
    -- Pantry
    ('rice', 'arroz', 'pantry'), ('beans', 'frijoles', 'pantry'), ('lentils', 'lentejas', 'pantry'),
    ('chickpeas', 'garbanzos', 'pantry'), ('pasta', 'pasta', 'pantry'), ('spaghetti', 'espaguetis', 'pantry'),
    ('noodles', 'fideos', 'pantry'), ('flour', 'harina', 'pantry'), ('sugar', 'azúcar', 'pantry'),
    ('salt', 'sal', 'pantry'), ('pepper', 'pimienta', 'pantry'), ('cinnamon', 'canela', 'pantry'),
    ('oregano', 'orégano', 'pantry'), ('cumin', 'comino', 'pantry'), ('vanilla', 'vainilla', 'pantry'),
    ('yeast', 'levadura', 'pantry'), ('oil', 'aceite', 'pantry'), ('vinegar', 'vinagre', 'pantry'),
    ('cereal', 'cereal', 'pantry'), ('oatmeal', 'avena', 'pantry'), ('granola', 'granola', 'pantry'),
    ('honey', 'miel', 'pantry'), ('jam', 'mermelada', 'pantry'), ('peanut butter', 'crema de cacahuate', 'pantry'),
    ('ketchup', 'cátsup', 'pantry'), ('mayonnaise', 'mayonesa', 'pantry'), ('mustard', 'mostaza', 'pantry'),
    ('salsa', 'salsa', 'pantry'), ('olives', 'aceitunas', 'pantry'), ('pickles', 'pepinillos', 'pantry'),
    ('soup', 'sopa', 'pantry'), ('broth', 'caldo', 'pantry'), ('sardines', 'sardinas', 'pantry'),
    ('cookies', 'galletas', 'pantry'), ('chips', 'papitas', 'pantry'), ('popcorn', 'palomitas', 'pantry'),
    ('nuts', 'nueces', 'pantry'), ('peanuts', 'cacahuates', 'pantry'), ('almonds', 'almendras', 'pantry'),
    ('raisins', 'pasas', 'pantry'), ('chocolate', 'chocolate', 'pantry'),
    -- Drinks
    ('water', 'agua', 'drinks'), ('juice', 'jugo', 'drinks'), ('coffee', 'café', 'drinks'), ('tea', 'té', 'drinks'),
    ('soda', 'refresco', 'drinks'), ('lemonade', 'limonada', 'drinks'), ('beer', 'cerveza', 'drinks'),
    ('wine', 'vino', 'drinks'),
    -- Household
    ('detergent', 'detergente', 'household'), ('softener', 'suavizante', 'household'), ('bleach', 'cloro', 'household'),
    ('soap', 'jabón', 'household'), ('cleaner', 'limpiador', 'household'), ('sponges', 'esponjas', 'household'),
    ('gloves', 'guantes', 'household'), ('wipes', 'toallitas', 'household'), ('napkins', 'servilletas', 'household'),
    ('paper', 'papel', 'household'), ('towels', 'toallas', 'household'), ('foil', 'aluminio', 'household'),
    ('bags', 'bolsas', 'household'), ('filters', 'filtros', 'household'), ('batteries', 'pilas', 'household'),
    ('lightbulbs', 'focos', 'household'), ('candles', 'velas', 'household'),
    -- Personal care
    ('shampoo', 'champú', 'personal'), ('conditioner', 'acondicionador', 'personal'),
    ('toothpaste', 'pasta de dientes', 'personal'), ('toothbrush', 'cepillo de dientes', 'personal'),
    ('deodorant', 'desodorante', 'personal'), ('razors', 'rastrillos', 'personal'), ('sunscreen', 'bloqueador', 'personal'),
    ('tissues', 'pañuelos', 'personal'), ('diapers', 'pañales', 'personal'), ('tampons', 'tampones', 'personal'),
    ('makeup', 'maquillaje', 'personal'), ('vitamins', 'vitaminas', 'personal'), ('aspirin', 'aspirina', 'personal'),
    ('bandages', 'curitas', 'personal'), ('medicine', 'medicina', 'personal'),
    -- Meat & fish
    ('meat', 'carne', 'meat'), ('chicken', 'pollo', 'meat'), ('beef', 'res', 'meat'), ('pork', 'cerdo', 'meat'),
    ('turkey', 'pavo', 'meat'), ('ham', 'jamón', 'meat'), ('bacon', 'tocino', 'meat'), ('sausages', 'salchichas', 'meat'),
    ('chorizo', 'chorizo', 'meat'), ('steak', 'bistec', 'meat'), ('meatballs', 'albóndigas', 'meat'),
    ('fish', 'pescado', 'meat'), ('salmon', 'salmón', 'meat'), ('shrimp', 'camarones', 'meat'),
    -- Dairy & eggs
    ('milk', 'leche', 'dairy'), ('eggs', 'huevos', 'dairy'), ('cheese', 'queso', 'dairy'), ('butter', 'mantequilla', 'dairy'),
    ('margarine', 'margarina', 'dairy'), ('yogurt', 'yogur', 'dairy'), ('cream', 'crema', 'dairy'),
    -- Frozen
    ('ice', 'hielo', 'frozen'), ('ice cream', 'helado', 'frozen'), ('popsicles', 'paletas', 'frozen'),
    ('pizza', 'pizza', 'frozen'), ('peas', 'chícharos', 'frozen'), ('waffles', 'waffles', 'frozen')
  ) w (en, es, aisle);
$$;

-- An aisle for a parsed name ("2 lb ground beef" → "ground beef" → meat), from food_words:
-- lowercased, accents dropped with translate(), anything but letters and digits a space; the whole
-- name first, then its words from the last ("chicken broth" is broth, pantry), with a trailing "s"
-- or "es" also tried on either side ("tomato" is "tomatoes"); an exact word wins over one that
-- matches only that way. Else 'other'. (translate() takes the accented capitals too: the C locale
-- lowercases ASCII only.)
create function private.guess_aisle(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  with n as (
    select btrim(regexp_replace(translate(lower(coalesce(p_name, '')),
                                          'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                                          'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc'),
                                '[^a-z0-9]+', ' ', 'g')) as name
  ),
  -- What to look up, in order: the whole name, then each word from the last.
  tries as (
    select n.name as w, true as whole, 0::bigint as k from n where n.name <> ''
    union all
    select x.w, false, x.k from n cross join lateral regexp_split_to_table(n.name, ' ') with ordinality x (w, k)
    where n.name <> ''
  ),
  t as (
    select y.w, y.whole, y.k,
           array_remove(array[y.w, case when char_length(y.w) >= 4 and right(y.w, 1) = 's' then left(y.w, -1) end,
                                   case when char_length(y.w) >= 5 and right(y.w, 2) = 'es' then left(y.w, -2) end], null) as forms
    from tries y
  ),
  f as (
    select w.aisle, w.en, z.word,
           array_remove(array[z.word, case when char_length(z.word) >= 4 and right(z.word, 1) = 's' then left(z.word, -1) end,
                                      case when char_length(z.word) >= 5 and right(z.word, 2) = 'es' then left(z.word, -2) end], null) as forms
    from private.food_words() w
    cross join lateral (
      select btrim(regexp_replace(translate(lower(x.word),
                                            'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                                            'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc'),
                                  '[^a-z0-9]+', ' ', 'g')) as word
      from (values (w.en), (w.es)) x (word)
      where x.word is not null
    ) z
  )
  select coalesce((select f.aisle
                   from t join f on f.forms && t.forms
                   order by t.whole desc, t.k desc, (f.word = t.w) desc, f.en
                   limit 1),
                  'other');
$$;

-- The same thing in p_lang ('en' or 'es') when the whole name, normalized as in guess_aisle,
-- is a food_words entry in the other language: "Leche" read in English is 'milk', "Milk" in
-- Spanish 'leche'. Null otherwise, and when the word in p_lang is the name itself
-- ("Tortillas", "Melon"). A definer function, so a member's shopping_list() can read the word
-- list (food_words is granted to nobody).
create function private.food_other(p_name text, p_lang text)
returns text
language sql
immutable
security definer
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

-- ---------------------------------------------------------------------
-- The shopping list's rules (§4)
-- ---------------------------------------------------------------------

-- The signed-in caller's active person (people.email = current_email()), or a null row.
-- It acts for nobody but the caller; shopping_list() (invoker) needs it for the reader's language.
create function private.shop_who()
returns public.people
language sql
stable
set search_path = ''
as $$
  select p.* from public.people p where public.current_email() <> '' and p.email = public.current_email() and p.active;
$$;

-- One more change ('changes') or tick ('ticks') from a My day link today. The upsert's row
-- lock queues her parallel calls, so the count is exact. Past 30 changes or 100 ticks a day it
-- refuses (P0001), and the refused call's own count rolls back with it.
create function private.count_my_day(p_person uuid, p_what text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if p_what is null or p_what not in ('changes', 'ticks') then
    raise exception 'count_my_day counts changes or ticks.' using errcode = '22023';
  end if;
  insert into public.my_day_use as u (person_id, day, changes, ticks)
  values (p_person, public.today_local(), (p_what = 'changes')::int, (p_what = 'ticks')::int)
  on conflict (person_id, day) do update
    set changes = u.changes + (p_what = 'changes')::int, ticks = u.ticks + (p_what = 'ticks')::int
  returning case p_what when 'changes' then u.changes else u.ticks end into n;
  if p_what = 'changes' and n > 30 then
    raise exception 'Too many changes from My day today.' using errcode = 'P0001';
  end if;
  if p_what = 'ticks' and n > 100 then
    raise exception 'Too many ticks from My day today.' using errcode = 'P0001';
  end if;
end;
$$;

-- The one add rule, shared by members and My day (§4.1). Returns {result, item_id, name}:
-- 'added' (a new line), 'already' (it was to buy: one line, the note joins) or 'back' (it was
-- bought: back on the list). name is the line's own name ("Milk" when "Leche" joined it).
--   1. Clean and split: "2 lb ground beef" is ground beef (note "2 lb"), "Milk: 2 gallons" is
--      Milk (note "2 gallons"). The text is cut to 200 characters before anything else.
--   2. Which line: a locked and an unlocked line are separate. From My day only the unlocked
--      one is ever looked at; signed in, the line with the lock asked for, else the other one
--      (a re-add never unlocks; lock on makes an unlocked line locked). If no line has the name,
--      a line to buy with its twin in the other language counts ("Leche" while "Milk" is to buy).
--   3. Nothing to change (to buy, the lock stays, no new note): 'already', not counted, so a
--      resend after a lost reply is never refused.
--   4. Anything else from My day is counted first (private.count_my_day).
--   5-7. A new line (at most 200 to buy; 150 from My day, so the family can always add), the note
--      joining a line to buy, or a bought line back on the list with its aisle kept.
-- p_by is who it's for (added_by); from My day, updated_by is "<name> (My day)".
create function private.list_add(p_name text, p_private boolean, p_by uuid, p_my_day boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  s       text := private.clean_text(left(p_name, 200), 100);   -- cut first: a huge input costs nothing
  m       text[];
  v_name  text;
  v_note  text;
  v_lock  boolean := coalesce(p_private, false) and not coalesce(p_my_day, false);
  v_day   boolean := coalesce(p_my_day, false);
  v_cap   int := case when coalesce(p_my_day, false) then 150 else 200 end;
  v_who   text;
  v_twin  text;
  v_lang  text;
  v_other text;
  v_new   text;
  counted boolean := false;
  line    public.shopping_items;
begin
  -- 1. Clean and split. A leading amount (1 to 3 digits, an optional "x", an optional unit word
  --    and "of" or "de") goes in the note when a name of 3 or more characters follows; otherwise
  --    the text after the first ":" is the note. ("2% milk", "7up" and "7 Up" stay whole.)
  --    The name's first letter may be any Latin-1 letter, so "2 ñames" splits under any locale.
  m := regexp_match(s, '^([0-9]{1,3})(?:\s*x)?\s+(?:(lbs?|oz|kg|g|dozen|packs?|bags?|cans?|bottles?|box(?:es)?|jars?|gallons?|bunch(?:es)?|libras?|kilos?|docenas?|paquetes?|bolsas?|latas?|botellas?|cajas?)\s+(?:(?:of|de)\s+)?)?([[:alpha:]À-ÖØ-öø-ÿ].{2,})$', 'i');
  if m is not null then
    v_name := m[3];
    v_note := m[1] || coalesce(' ' || m[2], '');
  elsif strpos(s, ':') > 0 then
    v_name := left(s, strpos(s, ':') - 1);
    v_note := substr(s, strpos(s, ':') + 1);
  else
    v_name := s;
  end if;
  v_name := nullif(private.clean_text(v_name, 60), '');
  v_note := nullif(private.clean_text(v_note, 80), '');
  if v_name is null then
    raise exception 'Type what to buy.' using errcode = '22023';
  end if;
  if v_day then
    v_who := (select p.name from public.people p where p.id = p_by) || ' (My day)';
  end if;

  loop
    -- 2. Which line, locked (for update) before anything else.
    select * into line
    from public.shopping_items i
    where i.name_key = lower(v_name) and (not v_day or not i.private)
    order by i.private = v_lock desc
    limit 1
    for update;
    -- Other language: the twin's line, only while it is to buy and where the rules above may
    -- look. v_twin is the name's word in v_lang; a line is its twin when its own word in the
    -- name's language is the name's (food_other gives the list's spelling, so they compare).
    if line.id is null then
      foreach v_lang in array array['en', 'es'] loop
        v_twin := private.food_other(v_name, v_lang);
        continue when v_twin is null;
        v_other := case v_lang when 'en' then 'es' else 'en' end;
        select * into line
        from public.shopping_items i
        where i.bought_at is null and (not v_day or not i.private)
          and private.food_other(i.name, v_other) = private.food_other(v_twin, v_other)
          -- (making it locked must not clash with a locked line of the same name)
          and not (v_lock and not i.private
                   and exists (select 1 from public.shopping_items j where j.name_key = i.name_key and j.private))
        order by i.private = v_lock desc, i.added_at, i.name_key, i.id
        limit 1
        for update;
        exit when line.id is not null;
      end loop;
    end if;
    exit when line.id is not null;

    -- 4 and 5. None found: counted, then a new line.
    if v_day and not counted then
      perform private.count_my_day(p_by, 'changes');
      counted := true;
    end if;
    if (select count(*) from public.shopping_items i where i.bought_at is null) >= v_cap then
      raise exception 'The list is full.' using errcode = '54000';
    end if;
    insert into public.shopping_items (name, note, aisle, private, added_at, added_by, updated_by)
    values (v_name, v_note, private.guess_aisle(v_name), v_lock, private.now(), p_by, v_who)
    on conflict (name_key, private) do nothing
    returning * into line;
    if line.id is not null then
      return jsonb_build_object('result', 'added', 'item_id', line.id, 'name', line.name);
    end if;
    -- Another phone added the same name a moment before: look again, and go on with that
    -- line, so this call's note isn't lost.
  end loop;

  v_new := case when line.bought_at is not null then v_note
                when v_note is null or v_note = any (string_to_array(line.note, ' · ')) then line.note
                else private.clean_text(concat_ws(' · ', line.note, v_note), 80) end;

  -- 3. Nothing to change.
  if line.bought_at is null and not (v_lock and not line.private) and v_new is not distinct from line.note then
    return jsonb_build_object('result', 'already', 'item_id', line.id, 'name', line.name);
  end if;

  -- 4. Counted, from My day.
  if v_day and not counted then
    perform private.count_my_day(p_by, 'changes');
  end if;

  -- 6. To buy already: it stays one line; the new note joins after " · ".
  if line.bought_at is null then
    update public.shopping_items
    set note = v_new, private = line.private or v_lock, updated_by = coalesce(v_who, updated_by)
    where id = line.id;
    return jsonb_build_object('result', 'already', 'item_id', line.id, 'name', line.name);
  end if;

  -- 7. Bought: back on the list, with the new note (or none). Its aisle stays, so a correction sticks.
  if (select count(*) from public.shopping_items i where i.bought_at is null) >= v_cap then
    raise exception 'The list is full.' using errcode = '54000';
  end if;
  update public.shopping_items
  set bought_at = null, bought_by = null, note = v_new, added_at = private.now(), added_by = p_by,
      private = line.private or v_lock, updated_by = coalesce(v_who, updated_by)
  where id = line.id;
  return jsonb_build_object('result', 'back', 'item_id', line.id, 'name', line.name);
end;
$$;

-- The one tick rule (§4.2). True when something changed. Every write is a "set" against the
-- state the phone saw (p_seen: added_at for a line to buy, bought_at for a bought one), never a
-- toggle: a resend after a lost reply finds the row already changed, and a change that waited
-- offline never undoes a newer one; both get false.
--   Bought:     only a line to buy whose added_at is p_seen.
--   Not bought: only a line whose bought_at is p_seen. From My day only her own tick of the last
--               15 minutes (any other matching line: 42501); signed in, any. Bought less than 15
--               minutes ago it's an Undo (added_at and added_by stay); older, it goes back on the
--               list (added now, by p_by).
-- From My day a locked line counts as no line, and a call about to change a row is counted.
create function private.list_buy(p_item uuid, p_bought boolean, p_seen timestamptz, p_by uuid, p_my_day boolean)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  line  public.shopping_items;
  v_now timestamptz := private.now();
  v_day boolean := coalesce(p_my_day, false);
  v_who text;
begin
  if p_bought is null then
    raise exception 'Choose bought or not.' using errcode = '22023';
  end if;
  if p_seen is null then
    raise exception 'Reload the list to see it as it is now.' using errcode = '22023';
  end if;
  select * into line from public.shopping_items i where i.id = p_item and (not v_day or not i.private) for update;
  if not found then
    return false;
  end if;
  if v_day then
    v_who := (select p.name from public.people p where p.id = p_by) || ' (My day)';
  end if;

  if p_bought then
    if line.bought_at is not null or line.added_at <> p_seen then
      return false;
    end if;
    if v_day then
      perform private.count_my_day(p_by, 'ticks');
    end if;
    update public.shopping_items
    set bought_at = v_now, bought_by = p_by, updated_by = coalesce(v_who, updated_by)
    where id = line.id;
    return true;
  end if;

  if line.bought_at is distinct from p_seen then
    return false;
  end if;
  if v_day and (line.bought_by is distinct from p_by or line.bought_at < v_now - interval '15 minutes') then
    raise exception 'Only your own tick can be undone, for 15 minutes.' using errcode = '42501';
  end if;
  if v_day then
    perform private.count_my_day(p_by, 'ticks');
  end if;
  update public.shopping_items
  set bought_at = null, bought_by = null,
      added_at = case when line.bought_at >= v_now - interval '15 minutes' then line.added_at else v_now end,
      added_by = case when line.bought_at >= v_now - interval '15 minutes' then line.added_by else p_by end,
      updated_by = coalesce(v_who, updated_by)
  where id = line.id;
  return true;
end;
$$;

-- My day's list (§3.4), for a helper: her language, the household's local date and time of
-- this answer, whether she can add, the unlocked lines to buy (A–Z), the unlocked lines bought
-- since the household's midnight and her own ticks of the last 15 minutes (so a tick at 23:55
-- can still be undone at 00:05), and, only when she can add, up to 60 unlocked names bought in
-- the last 30 days (most recent first). No names of family members, no ids of people, nothing
-- locked. other: the name in her language, when the word list knows it in the other one.
-- seen: the row's state as the phone saw it, sent back as p_seen (to_jsonb keeps microseconds).
create function private.list_for_helper(p_person uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with s as (
    select p.language as lang, coalesce(h.helper_list = 'add', false) as can_add, private.now() as now,
           public.today_local()::timestamp at time zone private.tz() as midnight
    from public.people p
    left join public.household h on true
    where p.id = p_person
  )
  select jsonb_build_object(
    'language', s.lang,
    'as_of', to_char(s.now at time zone private.tz(), 'YYYY-MM-DD"T"HH24:MI'),
    'can_add', s.can_add,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'note', i.note, 'aisle', i.aisle,
                                                           'seen', i.added_at)
                                        || jsonb_strip_nulls(jsonb_build_object('other', private.food_other(i.name, s.lang)))
                                        order by i.name_key, i.id)
                       from public.shopping_items i
                       where i.bought_at is null and not i.private), '[]'),
    'bought', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'note', i.note, 'aisle', i.aisle,
                                                            'seen', i.bought_at,
                                                            'undo', i.bought_by = p_person and i.bought_at >= s.now - interval '15 minutes')
                                         order by i.bought_at desc, i.name_key, i.id)
                        from public.shopping_items i
                        where i.bought_at is not null and not i.private
                          and (i.bought_at >= s.midnight
                               or (i.bought_by = p_person and i.bought_at >= s.now - interval '15 minutes'))), '[]'))
    -- aisle too, so Comprar otra vez can group them (§7.2).
    || case when s.can_add
            then jsonb_build_object('suggest', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'aisle', x.aisle)
                                                                         || jsonb_strip_nulls(jsonb_build_object('other', private.food_other(x.name, s.lang)))
                                                                         order by x.bought_at desc, x.name_key, x.id)
                                                         from (select i.id, i.name, i.name_key, i.aisle, i.bought_at
                                                               from public.shopping_items i
                                                               where i.bought_at is not null and not i.private
                                                                 and i.bought_at >= s.now - interval '30 days'
                                                               order by i.bought_at desc, i.name_key, i.id
                                                               limit 60) x), '[]'))
            else '{}' end
  from s;
$$;

-- ---------------------------------------------------------------------
-- Pages: the list (§3.4)
-- ---------------------------------------------------------------------

-- The list as the Food page polls it (every 10 seconds while it is on screen), with the
-- caller's rights: members see it all, locked lines included; anyone else gets empty lists.
--   to_buy: [{id, name, note, aisle, private, added_by, seen, other}], A–Z
--   bought: [{id, name, note, aisle, private, bought_by, seen}], everything bought since the
--           household's midnight, the latest first
-- added_by and bought_by are person ids. seen is added_at (to buy) or bought_at (bought), as
-- to_jsonb writes a timestamptz; the page sends it back as p_seen. other: the name in the
-- reader's language when the word list knows it in the other one ("Leche" is 'milk' for Alex).
-- Buy again comes from the page's own table read, so this answer stays small.
create function public.shopping_list()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with s as (
    select coalesce((private.shop_who()).language, 'en') as lang, private.now() as now,
           public.today_local()::timestamp at time zone private.tz() as midnight
  )
  select jsonb_build_object(
    'as_of', to_char(s.now at time zone private.tz(), 'YYYY-MM-DD"T"HH24:MI'),
    'to_buy', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'note', i.note, 'aisle', i.aisle,
                                                            'private', i.private, 'added_by', i.added_by, 'seen', i.added_at)
                                         || jsonb_strip_nulls(jsonb_build_object('other', private.food_other(i.name, s.lang)))
                                         order by i.name_key, i.id)
                        from public.shopping_items i
                        where i.bought_at is null), '[]'),
    'bought', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'note', i.note, 'aisle', i.aisle,
                                                            'private', i.private, 'bought_by', i.bought_by, 'seen', i.bought_at)
                                         order by i.bought_at desc, i.name_key, i.id)
                        from public.shopping_items i
                        where i.bought_at >= s.midnight), '[]'))
  from s;
$$;

-- ---------------------------------------------------------------------
-- Signed-in actions (each checks membership first, as complete_task does)
-- Write first, read in a later statement: the snapshot then sees the write.
-- ---------------------------------------------------------------------

-- Add to the list (§4.1): {result, item_id, name} and the list.
create function public.add_to_list(p_name text, p_private boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
begin
  if not private.is_member() then
    raise exception 'Only the family can change the shopping list.' using errcode = '42501';
  end if;
  r := private.list_add(p_name, coalesce(p_private, false), (private.shop_who()).id, false);
  return r || public.shopping_list();
end;
$$;

-- Bought, or not (Undo, or back on the list) (§4.2): {changed} and the list.
create function public.buy_item(p_item uuid, p_bought boolean, p_seen timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v boolean;
begin
  if not private.is_member() then
    raise exception 'Only the family can change the shopping list.' using errcode = '42501';
  end if;
  v := private.list_buy(p_item, p_bought, p_seen, (private.shop_who()).id, false);
  return jsonb_build_object('changed', v) || public.shopping_list();
end;
$$;

-- ---------------------------------------------------------------------
-- My day: the list (§3.4, §7.2). The token is the key. An unknown token, an inactive person
-- and a missing token get null; a locked line is never shown, matched or changed, and its id
-- is answered exactly as an unknown id. Only a helper, and only while helper_list isn't off.
-- ---------------------------------------------------------------------

-- The list for a helper's My day, or null.
create function public.get_list_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me     public.people;
  v_mode text;
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  select h.helper_list into v_mode from public.household h;
  if me.role <> 'helper' or coalesce(v_mode, 'off') = 'off' then
    return null;
  end if;
  return private.list_for_helper(me.id);
end;
$$;

-- Add from My day (helper_list 'add' only): {result, item_id, name} and her list. It only ever
-- finds or makes an unlocked line. Anything over 200 characters is refused before any work.
create function public.add_to_list_by_token(p_token text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me     public.people;
  v_mode text;
  r      jsonb;
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  select h.helper_list into v_mode from public.household h;
  if me.role <> 'helper' or coalesce(v_mode, 'off') = 'off' then
    raise exception 'The shopping list isn''t on your My day.' using errcode = '42501';
  end if;
  if v_mode <> 'add' then
    raise exception 'You can''t add to the list from My day.' using errcode = '42501';
  end if;
  if p_name is null then
    raise exception 'Type what to buy.' using errcode = '22023';
  end if;
  if char_length(p_name) > 200 then
    raise exception 'That''s too long to add.' using errcode = '22023';
  end if;
  r := private.list_add(p_name, false, me.id, true);
  return r || private.list_for_helper(me.id);
end;
$$;

-- Tick or Undo from My day (See and tick, or See, tick and add): {changed} and her list.
create function public.buy_item_by_token(p_token text, p_item uuid, p_bought boolean, p_seen timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me     public.people;
  v_mode text;
  v      boolean;
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  select h.helper_list into v_mode from public.household h;
  if me.role <> 'helper' or coalesce(v_mode, 'off') = 'off' then
    raise exception 'The shopping list isn''t on your My day.' using errcode = '42501';
  end if;
  v := private.list_buy(p_item, p_bought, p_seen, me.id, true);
  return jsonb_build_object('changed', v) || private.list_for_helper(me.id);
end;
$$;

-- ---------------------------------------------------------------------
-- Meals (§5, §9, §10)
-- ---------------------------------------------------------------------

-- The title for a cooked meal ("Tacos"); the quick kind's word otherwise ("Leftovers" / "Sobras").
create function private.meal_title(m public.meals, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when m.kind = 'cook' then m.title else private.food_word(m.kind, p_lang) end;
$$;

-- One meal as a row of the morning email's Today, in the shape render.ts draws:
-- "Dinner | Tacos · Sam cooks". detail is who's on it ("Sam cooks", "Sam's on dinner"; for that
-- person "You cook" / "You're on dinner", then " · " and the note). p_hide: "Private item" for
-- a kid or helper who isn't on a locked meal.
create function private.meal_digest_item(m public.meals, p_person uuid, p_lang text, p_hide boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', 'meal',
    'item_id', m.id,
    'occurrence', m.day,
    'time', private.food_word(m.slot, p_lang),
    'title', case when coalesce(p_hide, false) then private.word('private_item', p_lang) else private.meal_title(m, p_lang) end,
    'detail', nullif(concat_ws(' · ',
                case when c.id is null then null
                     when c.id = p_person then private.food_word(case when m.kind = 'cook' then 'you_cook' else 'you_on_dinner' end, p_lang)
                     else replace(private.food_word(case when m.kind = 'cook' then 'cooks' else 'on_dinner' end, p_lang),
                                  '{name}', private.short_name(c)) end,
                case when c.id = p_person then m.note end), ''),
    'contractor_phone', null,
    'status', 'open')
  from (select 1) one
  left join public.people c on c.id = m.cook_id and c.active;
$$;

-- The wall's meal rows (§10), with the same 14 columns as private.calendar_desired: one all-day
-- event per meal on Hub – Family (the writing Family calendar), while household.meals_on_wall is
-- on. "Dinner: Tacos (Sam)", with the first name of the person on it while they are on the family
-- list, in the calendar's language (English, as calendar_desired has it for Family); a locked meal
-- is "Dinner: Private item", visibility private, with no name. The description is "Made by Home
-- Hub…", who's on it ("Sam cooks") unless locked, and with a site the link to #/food. Never the
-- note, the link or anything from the list. Its id is calendar_key's 'meal|<id>|<day>|<calendar>|'.
create function private.meal_events(p_from date, p_to date, p_site text)
returns table (calendar_id uuid, google_calendar text, base_id text, item_kind text, item_id uuid, job_id text,
               occurrence date, part text, day date, end_day date, title text, private boolean, body jsonb, hash text)
language sql
stable
set search_path = ''
as $$
  with s as (
    select nullif(btrim(p_site), '') as site
  ),
  fam as (
    select c.id, c.google_id, 'en'::text as lang
    from public.calendars c
    where c.writes and c.kind = 'family'
  ),
  built as (
    select f.id as cal_id, f.google_id, m.id as item_id, m.day, m.private as hidden,
           left(private.food_word(m.slot, f.lang) || ': '
                  || case when m.private then private.word('private_item', f.lang)
                          else private.meal_title(m, f.lang) || coalesce(' (' || private.short_name(c) || ')', '') end,
                120) as summary,
           concat_ws(E'\n',
             private.calendar_word('made_by_hub', f.lang),
             case when not m.private and c.id is not null
                  then replace(private.food_word(case when m.kind = 'cook' then 'cooks' else 'on_dinner' end, f.lang),
                               '{name}', private.short_name(c)) end,
             case when s.site is not null
                  then replace(private.calendar_word('open_in_hub', f.lang), '{url}', s.site || '#/food') end) as description,
           private.calendar_event_id(private.calendar_key('meal', m.id, null, m.day, f.google_id, null)) as base
    from public.meals m
    cross join fam f
    cross join s
    left join public.people c on c.id = m.cook_id and c.active
    where m.day between p_from and p_to
      and coalesce((select h.meals_on_wall from public.household h), false)
  ),
  bodies as (
    select b.*, jsonb_strip_nulls(jsonb_build_object(
             'id', b.base,
             'status', 'confirmed',
             'summary', b.summary,
             'description', b.description,
             'start', jsonb_build_object('date', to_char(b.day::timestamp, 'YYYY-MM-DD')),
             'end', jsonb_build_object('date', to_char((b.day + 1)::timestamp, 'YYYY-MM-DD')),
             'transparency', 'transparent',
             'visibility', case when b.hidden then 'private' else 'default' end,
             'extendedProperties', jsonb_build_object('private', jsonb_build_object(
               'homehub', '1',
               'homehub_base', b.base,
               'homehub_kind', 'meal',
               'homehub_item', b.item_id::text,
               'homehub_occurrence', to_char(b.day::timestamp, 'YYYY-MM-DD'))))) as body
    from built b
  )
  select x.cal_id, x.google_id, x.base, 'meal'::text, x.item_id, null::text, x.day, ''::text, x.day, x.day,
         x.summary, x.hidden, x.body, md5(x.body::text)
  from bodies x
  order by x.google_id, x.base;
$$;

-- ---------------------------------------------------------------------
-- Replaced: My day and the day's message (same signatures as 0002)
-- ---------------------------------------------------------------------

-- Today and tomorrow for the person with this token, or null.
-- As in 0002, plus two keys that are left out when empty (so with no meals and no list it is
-- exactly 0002's answer):
--   • days[i].meals: [{slot, label, title, cook, cook_word, mine}] in breakfast, lunch, dinner
--     order; "Private item" for a locked meal they aren't on; the note and link only when mine.
--   • list: {to_buy} for a helper while helper_list isn't off, once the household has a list.
create or replace function public.get_person_day(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me    public.people;
  today date := public.today_local();
  v_mode text;   -- v1.2
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  select h.helper_list into v_mode from public.household h;   -- v1.2

  return jsonb_build_object(
    'person', jsonb_build_object('name', me.name, 'language', me.language,
                                 'digest_enabled', me.digest_enabled,
                                 'email_confirmed', me.email_verified_at is not null),
    'today', today,
    'days', (select jsonb_agg(jsonb_build_object(
                      'day', d.day,
                      'items', coalesce((select jsonb_agg(private.my_day_item(a, me.id, me.language)
                                                          order by private.item_order(a), a.local_start, a.title)
                                         from private.person_items(me.id, d.day) a), '[]'))
                      -- v1.2: the day's meals, left out when there are none.
                      || coalesce((select jsonb_build_object('meals', jsonb_agg(
                                            jsonb_build_object(
                                              'slot', m.slot,
                                              'label', private.food_word(m.slot, me.language),
                                              'title', case when m.private and not x.mine then private.word('private_item', me.language)
                                                            else private.meal_title(m, me.language) end,
                                              'cook', case when c.id is not null then private.short_name(c) end,
                                              'cook_word', case when c.id is null then null
                                                                when x.mine then private.food_word(case when m.kind = 'cook' then 'you_cook'
                                                                                                        else 'you_on_dinner' end, me.language)
                                                                else replace(private.food_word(case when m.kind = 'cook' then 'cooks'
                                                                                                    else 'on_dinner' end, me.language),
                                                                             '{name}', private.short_name(c)) end,
                                              'mine', x.mine)
                                            || case when x.mine then jsonb_strip_nulls(jsonb_build_object('note', m.note, 'link', m.link))
                                                    else '{}' end
                                            order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id))
                                   from public.meals m
                                   left join public.people c on c.id = m.cook_id and c.active
                                   cross join lateral (select coalesce(c.id = me.id, false) as mine) x
                                   where m.day = d.day
                                   having count(*) > 0), '{}')
                    order by d.day)
             from (values (today), (today + 1)) d (day)),
    'late', coalesce((select jsonb_agg(private.my_day_item(i, me.id, me.language) order by cd.due, t.title)
                      from public.tasks t
                      cross join lateral (select private.current_due(t) as due) cd
                      cross join lateral private.task_item(t, cd.due, 'late') i
                      where t.responsible_id = me.id and t.active and t.done_at is null and cd.due < today),
                     '[]'))
    -- v1.2: the list button, for a helper while the list is on her My day, once anyone has
    -- added the first item (so the same-output check is unchanged).
    || case when me.role = 'helper' and coalesce(v_mode, 'off') <> 'off' and exists (select 1 from public.shopping_items)
            then jsonb_build_object('list', jsonb_build_object(
                   'to_buy', (select count(*) from public.shopping_items i where i.bought_at is null and not i.private)))
            else '{}' end;
end;
$$;

-- The message for one person's day, in their language: timed items in order,
-- all-day events, tasks due, then up to 3 late tasks. Used by the Today
-- page's "Send their day" buttons and by the morning email.
-- People by first name. Never notes (only a changed day's own note), never account
-- numbers; private items show as "Private item".
-- v1.2: then one line per meal they're on that day, in slot order, before Late ("Dinner: Tacos ·
-- You cook", "Cena: Sobras · Te encargas tú"). A locked meal's title too: the text goes to the
-- person on it. Never the note or the link.
create or replace function public.day_text(p_person uuid, p_day date)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  me     public.people;
  lang   text;
  lines  text[];
  late_n int;
begin
  select * into me from public.people p where p.id = p_person;
  if not found or p_day is null then
    return null;
  end if;
  lang := me.language;

  lines := array[private.short_name(me) || ' · ' || private.day_label(p_day, lang)]
        || array(select private.text_line(a, p_person, lang)
                 from private.person_items(p_person, p_day) a
                 where a.status = 'open'
                 order by private.item_order(a), a.local_start, a.title)
        -- v1.2: the meals they're on (an inactive person is on none).
        || array(select private.food_word(m.slot, lang) || ': ' || private.meal_title(m, lang) || ' · '
                        || private.food_word(case when m.kind = 'cook' then 'you_cook' else 'you_on_dinner' end, lang)
                 from public.meals m
                 where m.day = p_day and m.cook_id = p_person and me.active
                 order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id);
  if cardinality(lines) = 1 then
    lines := lines || private.word('nothing_planned', lang);
  end if;

  select count(*) into late_n
  from public.tasks t
  where t.responsible_id = p_person and t.active and t.done_at is null and private.current_due(t) < p_day;
  if late_n > 0 then
    lines := lines || (private.word('late', lang) || ':')
          || array(select '☐ ' || case when x.private then private.word('private_item', lang) else x.title end
                          || ' (' || private.short_date(x.due, lang) || ')'
                   from (select t.private, t.title, private.current_due(t) as due
                         from public.tasks t
                         where t.responsible_id = p_person and t.active and t.done_at is null) x
                   where x.due < p_day
                   order by x.due, x.title
                   limit 3);
    if late_n > 3 then
      lines := lines || replace(private.word('more', lang), '{n}', (late_n - 3)::text);
    end if;
  end if;

  return array_to_string(lines, E'\n');
end;
$$;

-- ---------------------------------------------------------------------
-- Wrapped: the morning email (§3.4, §9)
-- ---------------------------------------------------------------------
-- 0003's digest_for keeps its body and its grant (service_role only), as private.digest_for_v3.
alter function public.digest_for(uuid, date) rename to digest_for_v3;
alter function public.digest_for_v3(uuid, date) set schema private;

-- Everything the morning email needs: 0003's email, plus the day's meals.
--   1. No meal that day (or no email): exactly 0003's email.
--   2. One row per meal at the end of Today (private.meal_digest_item), in slot order; "Private
--      item" for a kid or helper who isn't on a locked meal.
--   3. A day 0003 called "Nothing planned" (nothing in Today or Late) is named by its first meal
--      instead: "Tue Oct 27: Dinner: Tacos · Sam cooks" ("… · You cook" for the cook). A locked
--      meal is "Dinner: Private item" there, for everyone: the subject shows on lock screens.
--   4. The person on a meal gets an email that day (empty false); nobody else gets one just
--      because there is a dinner.
-- 0003's body calls public.day_text by name, so the parents' blocks for each kid and helper get
-- the cook line too.
create function public.digest_for(p_person uuid, p_local_date date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  j       jsonb := private.digest_for_v3(p_person, p_local_date);
  me      public.people;
  lang    text;
  hide    boolean;
  v_first public.meals;
  cook    public.people;
begin
  if j is null or not exists (select 1 from public.meals m where m.day = p_local_date) then
    return j;
  end if;
  select * into me from public.people p where p.id = p_person;
  lang := me.language;
  hide := me.role in ('kid', 'helper');

  if jsonb_array_length(j -> 'today') = 0 and jsonb_array_length(j -> 'late') = 0 then
    select * into v_first from public.meals m where m.day = p_local_date
    order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id
    limit 1;
    select * into cook from public.people p where p.id = v_first.cook_id and p.active;
    j := jsonb_set(j, '{subject}', to_jsonb((j ->> 'date_label') || ': ' || private.food_word(v_first.slot, lang) || ': '
           || case when v_first.private then private.word('private_item', lang)
                   else private.meal_title(v_first, lang)
                        || coalesce(' · ' || case when cook.id is null then null
                                                  when cook.id = me.id
                                                    then private.food_word(case when v_first.kind = 'cook' then 'you_cook'
                                                                                else 'you_on_dinner' end, lang)
                                                  else replace(private.food_word(case when v_first.kind = 'cook' then 'cooks'
                                                                                      else 'on_dinner' end, lang),
                                                               '{name}', private.short_name(cook)) end, '') end));
  end if;

  j := jsonb_set(j, '{today}', (j -> 'today')
         || (select jsonb_agg(private.meal_digest_item(m, me.id, lang, hide and m.private and m.cook_id is distinct from me.id)
                              order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id)
             from public.meals m
             where m.day = p_local_date));

  if j -> 'empty' = 'true'::jsonb
     and exists (select 1 from public.meals m where m.day = p_local_date and m.cook_id = me.id) then
    j := jsonb_set(j, '{empty}', 'false'::jsonb);
  end if;
  return j;
end;
$$;

-- ---------------------------------------------------------------------
-- Wrapped: the events Google should have (§3.4, §10)
-- ---------------------------------------------------------------------
-- 0003's calendar_desired keeps its body and its grants, as private.calendar_desired_v3.
-- calendar_plan, calendar_preview, calendar_store_events and calendar_finish call
-- private.calendar_desired by name, so they get the meal rows with no change of their own.
alter function private.calendar_desired(date, date, text) rename to calendar_desired_v3;

create function private.calendar_desired(p_from date, p_to date, p_site text)
returns table (calendar_id uuid, google_calendar text, base_id text, item_kind text, item_id uuid, job_id text,
               occurrence date, part text, day date, end_day date, title text, private boolean, body jsonb, hash text)
language sql
stable
set search_path = ''
as $$
  select * from private.calendar_desired_v3(p_from, p_to, p_site)
  union all
  select * from private.meal_events(p_from, p_to, p_site);
$$;

-- ---------------------------------------------------------------------
-- Replaced: the next Google writes (same signature as 0003)
-- ---------------------------------------------------------------------
-- As in 0003, with two changes marked "v1.2", both doing for meals what it does for events:
--   • a past dinner stays on Google as history (it no longer falls into "else true" the day it
--     leaves the window); a deleted, moved or locked meal's old event is still deleted;
--   • the past copy of a dinner locked later comes off with the deletes that hide something.
-- The next Google writes (§3.3), read only: what calendar_desired says Google should have for
-- the window (yesterday to 60 days ahead), compared with calendar_links on (Google calendar,
-- base_id). Each row also carries pending (all the writes still to do) and hiding (how many of
-- those hide something: an update that makes an item private, or a delete).
--   insert: desired, and never written (no link, or synced_at null)
--   update: desired, and the body changed (or hash is null: write it again)
--   delete: not desired, and the link ends in the window; or in the past, but its item was
--           deleted or is now private (or a health task), or it is a late-tasks line; or its
--           mapping is gone (calendar_id null, the calendar points elsewhere or only reads now)
-- Held back: inserts and updates for a calendar that isn't ok, wasn't seen with the access
-- role this sign-in needs, or wasn't approved (Start copying); deletes on a calendar that is
-- no_access or error (but not a gone mapping's); a link backing off (next_try_at) unless the
-- hub's version changed since the last try; the links of a project whose dates are stale; and
-- everything while Google's pause lasts.
-- Except: hiding what the hub itself wrote never waits for a calendar in error while Google still
-- lets the hub write there (access role writer or owner: renamed in Google, shared with "Make
-- changes and manage sharing", or one refused read). An update that makes an item private, and a
-- delete, of a link written there (synced_at set) go ahead; inserts and other updates still wait.
-- Order: updates that make an item private; then deletes in the window, and any delete of an item
-- that is now private (or a health task); then the rest by day, title, base_id; then the other
-- deletes of the past (deleted items, old late lines, a disconnected calendar's history), so a
-- mass delete of history never holds up today's changes.
create or replace function public.calendar_plan(p_site text default null, p_limit int default 60)
returns table (op text, calendar_id uuid, google_calendar text, base_id text, event_id text, gen int,
               item_kind text, item_id uuid, job_id text, occurrence date, part text, day date, end_day date,
               title text, body jsonb, hash text, pending int, hiding int)
language sql
stable
security invoker
set search_path = ''
as $$
  with s as (
    select public.today_local() - 1 as w_from, public.today_local() + 60 as w_to, private.now() as now,
           case y.auth when 'oauth' then 'owner' else 'writer' end as role
    from public.calendar_sync y
    where y.id and not coalesce(y.paused_until > private.now(), false)
  ),
  d as (
    select x.* from s cross join lateral private.calendar_desired(s.w_from, s.w_to, p_site) x
  ),
  wanted as (
    select case when l.base_id is null or l.synced_at is null then 'insert' else 'update' end as op,
           d.calendar_id, d.google_calendar, d.base_id, coalesce(l.event_id, d.base_id) as event_id, coalesce(l.gen, 0) as gen,
           d.item_kind, d.item_id, d.job_id, d.occurrence, d.part, d.day, d.end_day, d.title, b.body, md5(b.body::text) as hash,
           l.base_id as link, l.synced_at, l.hash as link_hash, l.next_try_at, l.tried_hash,
           c.status, c.access_role, c.copy_approved_at
    from d
    join public.calendars c on c.id = d.calendar_id
    left join public.calendar_links l on l.google_calendar = d.google_calendar and l.base_id = d.base_id
    cross join lateral (select case when l.event_id is not null and l.event_id <> d.base_id
                                    then jsonb_set(d.body, '{id}', to_jsonb(l.event_id)) else d.body end as body) b
  ),
  -- grp, the order: 0 updates that make an item private; 1 deletes that hide something now (in
  -- the window, or of an item that is now private or a health task); 2 the rest; 3 the other
  -- deletes of the past.
  ops as (
    select w.op, w.calendar_id, w.google_calendar, w.base_id, w.event_id, w.gen, w.item_kind, w.item_id, w.job_id,
           w.occurrence, w.part, w.day, w.end_day, w.title, w.body, w.hash,
           case when w.op = 'update' and w.body ->> 'visibility' = 'private' then 0 else 2 end as grp
    from wanted w
    cross join s
    where (w.link is null or w.synced_at is null or w.link_hash is distinct from w.hash)
      and ((w.status = 'ok' and w.access_role = s.role and w.copy_approved_at is not null)
           -- Making private what the hub already wrote there waits for nothing but write access.
           or (w.op = 'update' and w.synced_at is not null and w.body ->> 'visibility' = 'private'
               and w.status in ('ok', 'error') and w.access_role in ('writer', 'owner')))
      and not coalesce(w.next_try_at > s.now and w.hash is not distinct from w.tried_hash, false)
    union all
    select 'delete', l.calendar_id, l.google_calendar, l.base_id, l.event_id, l.gen, l.item_kind, l.item_id, l.job_id,
           l.occurrence, l.part, l.day, l.end_day, l.title, null, null,
           case when l.end_day >= s.w_from
                     or (l.item_kind = 'event' and exists (select 1 from public.events e where e.id = l.item_id and e.private))
                     or (l.item_kind = 'task' and exists (select 1 from public.tasks t
                                                          where t.id = l.item_id and (t.private or t.category = 'health')))
                     -- v1.2: the past copy of a dinner locked later, as for a private event.
                     or (l.item_kind = 'meal' and exists (select 1 from public.meals m where m.id = l.item_id and m.private))
                then 1 else 3 end
    from public.calendar_links l
    cross join s
    left join public.calendars c on c.id = l.calendar_id
    where not exists (select 1 from d where d.google_calendar = l.google_calendar and d.base_id = l.base_id)
      and not coalesce(l.next_try_at > s.now and l.tried_hash = 'delete', false)
      and (c.id is null or c.google_id <> l.google_calendar or not c.writes
           or ((c.status not in ('no_access', 'error')
                -- A calendar in error that the hub can still write to: what it wrote there comes off.
                or (c.status = 'error' and c.access_role in ('writer', 'owner') and l.synced_at is not null))
               and not (l.item_kind = 'project'
                        and exists (select 1 from public.projects p
                                    where p.id = l.item_id and p.on_calendar and p.task_dates is null
                                      and p.status not in ('idea', 'on-hold', 'done')))
               and (l.end_day >= s.w_from
                    or case l.item_kind
                         when 'event' then not exists (select 1 from public.events e where e.id = l.item_id and not e.private)
                         when 'task' then not exists (select 1 from public.tasks t
                                                      where t.id = l.item_id and not t.private and t.category <> 'health')
                         when 'project' then not exists (select 1 from public.projects p
                                                         where p.id = l.item_id
                                                           and (p.task_dates is null
                                                                or exists (select 1 from jsonb_array_elements(p.task_dates) x
                                                                           where x ->> 'id' = l.job_id)))
                         -- v1.2: a past dinner stays as history, unless it was deleted, moved or locked.
                         when 'meal' then not exists (select 1 from public.meals m
                                                      where m.id = l.item_id and m.day = l.occurrence and not m.private)
                         else true end)))
  )
  select o.op, o.calendar_id, o.google_calendar, o.base_id, o.event_id, o.gen, o.item_kind, o.item_id, o.job_id,
         o.occurrence, o.part, o.day, o.end_day, o.title, o.body, o.hash,
         (count(*) over ())::int, (count(*) filter (where o.grp <> 2) over ())::int
  from ops o
  order by o.grp, o.day, o.title, o.base_id
  limit greatest(coalesce(p_limit, 60), 0);
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The v1.2 client shows Food, and asks for meals and the list, only on 4.
-- (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 4;
$$;

-- ---------------------------------------------------------------------
-- Function permissions (§3.5)
-- New functions, public and private: revoke from public and anon (and whoever else
-- mustn't call them), then grant to who calls them. Replaced functions keep their grants.
-- ---------------------------------------------------------------------

-- Pages (service_role too, as for the read model).
revoke execute on function public.shopping_list()                                         from public, anon;
grant  execute on function public.shopping_list()                                         to authenticated, service_role;

-- Signed-in actions (each checks membership first).
revoke execute on function public.add_to_list(text, boolean)                              from public, anon, service_role;
revoke execute on function public.buy_item(uuid, boolean, timestamptz)                    from public, anon, service_role;
grant  execute on function public.add_to_list(text, boolean)                              to authenticated;
grant  execute on function public.buy_item(uuid, boolean, timestamptz)                    to authenticated;

-- The My day page: the token is the key.
revoke execute on function public.get_list_by_token(text)                                 from public, service_role;
revoke execute on function public.add_to_list_by_token(text, text)                        from public, service_role;
revoke execute on function public.buy_item_by_token(text, uuid, boolean, timestamptz)     from public, service_role;
grant  execute on function public.get_list_by_token(text)                                 to anon, authenticated;
grant  execute on function public.add_to_list_by_token(text, text)                        to anon, authenticated;
grant  execute on function public.buy_item_by_token(text, uuid, boolean, timestamptz)     to anon, authenticated;

-- hub-jobs: the new digest_for, as 0003's was.
revoke execute on function public.digest_for(uuid, date)                                  from public, anon, authenticated;
grant  execute on function public.digest_for(uuid, date)                                  to service_role;

-- Helpers in private: none for anon. The ones that act for someone else (list_add, list_buy,
-- count_my_day, list_for_helper) and the word list are for nobody but the definer functions
-- above. day_text runs as a member (Today's "Send their day") and as service_role (inside the
-- email), the wall as an admin (the preview) and as service_role, shopping_list() as the member
-- who calls it, and the tidy triggers as the member who saves: so what those reach is granted to
-- authenticated and service_role.
revoke execute on function private.meals_tidy()                                           from public, anon;
revoke execute on function private.shopping_items_tidy()                                  from public, anon;
revoke execute on function private.food_word(text, text)                                  from public, anon;
revoke execute on function private.food_words()                                           from public, anon, authenticated;
revoke execute on function private.guess_aisle(text)                                      from public, anon, authenticated;
revoke execute on function private.food_other(text, text)                                 from public, anon;
revoke execute on function private.shop_who()                                             from public, anon;
revoke execute on function private.count_my_day(uuid, text)                               from public, anon, authenticated;
revoke execute on function private.list_add(text, boolean, uuid, boolean)                 from public, anon, authenticated;
revoke execute on function private.list_buy(uuid, boolean, timestamptz, uuid, boolean)    from public, anon, authenticated;
revoke execute on function private.list_for_helper(uuid)                                  from public, anon, authenticated;
revoke execute on function private.meal_title(public.meals, text)                         from public, anon;
revoke execute on function private.meal_digest_item(public.meals, uuid, text, boolean)    from public, anon;
revoke execute on function private.meal_events(date, date, text)                          from public, anon;
revoke execute on function private.calendar_desired(date, date, text)                     from public, anon;
grant  execute on function private.food_word(text, text)                                  to authenticated, service_role;
grant  execute on function private.food_other(text, text)                                 to authenticated, service_role;
grant  execute on function private.shop_who()                                             to authenticated, service_role;
grant  execute on function private.meal_title(public.meals, text)                         to authenticated, service_role;
grant  execute on function private.meal_digest_item(public.meals, uuid, text, boolean)    to service_role;
grant  execute on function private.meal_events(date, date, text)                          to authenticated, service_role;
grant  execute on function private.calendar_desired(date, date, text)                     to authenticated, service_role;
-- One grant changes: the tidy triggers run as the member who saves a meal or renames an item.
grant  execute on function private.clean_text(text, int)                                  to authenticated;

commit;
