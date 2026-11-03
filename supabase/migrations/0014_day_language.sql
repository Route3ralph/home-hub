-- =====================================================================
-- HOME HUB v2 — migration 0014: My day's language switch (English | Español on a My day link)
-- Apply once, after 0013, and only once the site that understands it is live (docs/v2-design.md §19).
-- The contract is docs/v2-design.md §19.
--
-- Why
--   A helper or a kid reads My day in the language a parent chose on the Family page. This lets them flip it
--   themselves, on their own page, without asking: English or Español. It is the person's language everywhere
--   (My day, their morning email, their printed schedule), as if a parent had changed it.
--
-- What it adds
--   • New, for a My day link (anon, by its token): public.set_language_by_token(p_token text, p_lang text)
--     returns jsonb. It sets that person's people.language and answers get_person_day(p_token), so the page
--     redraws in the new language. Twenty-four token functions for anon in all.
--   • hub_schema_version() (14).
--
-- Rules
--   • One transaction. It refuses to run without 0013, twice, or on a database that isn't as 0013 left it.
--   • set search_path = '' on the new function; revoke then grant.
--   • A My day token only (private.person_by_token): never a tutor link's or a confirmation secret.
--   • A change counts as one of the link's My day changes (private.count_my_day, 30 a day); asking for the
--     language it already has changes and counts nothing.
--
-- Undo (not needed: nothing calls it before the site that knows it is live). If wanted, in the SQL editor:
--   drop function public.set_language_by_token(text, text);
--   create or replace function public.hub_schema_version() returns int language sql immutable set search_path = ''
--   as $$ select 13 $$;
-- 0014 can then run again. The site needs no change: it works on 13.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0013 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 13 then
    raise exception 'Recipes (migration 0013) isn''t installed (hub_schema_version() is %). Run 0013_recipes.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 14 then
    raise exception 'My day''s language switch (migration 0014) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regprocedure('public.set_language_by_token(text, text)') is not null then
    raise exception 'My day''s language switch (migration 0014) is already installed, but hub_schema_version() was set back to 13. To switch it on again, make hub_schema_version() return 14 (docs/v2-design.md §19). Nothing was changed.';
  end if;
  -- What this migration reads is as 0013 left it.
  if to_regclass('public.recipes') is null
     or to_regprocedure('private.person_by_token(text)') is null
     or to_regprocedure('private.count_my_day(uuid, text)') is null
     or to_regprocedure('public.get_person_day(text)') is null
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.people'::regclass and a.attname = 'language' and not a.attisdropped) then
    raise exception 'This database isn''t as migration 0013 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- My day (§19): its token is the key (private.person_by_token, as for every My day function: an unknown,
-- malformed or replaced token, or a person who isn't active: null).
-- ---------------------------------------------------------------------

-- English or Español for the person with this token: 'en' or 'es' (anything else: 22023 "Choose English or
-- Español."). Sets their people.language and nothing else; a change is one of the link's My day changes
-- (30 a day, P0001 past it). Answers get_person_day(p_token), in the new language.
create function public.set_language_by_token(p_token text, p_lang text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.people;
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if p_lang is null or p_lang not in ('en', 'es') then
    raise exception 'Choose English or Español.' using errcode = '22023';
  end if;
  if me.language is distinct from p_lang then
    perform private.count_my_day(me.id, 'changes');
    update public.people set language = p_lang where id = me.id;
  end if;
  return public.get_person_day(p_token);
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The switch shows on My day only on 14. (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 14;
$$;

-- ---------------------------------------------------------------------
-- Function permissions: a My day link's token is the key.
-- ---------------------------------------------------------------------
revoke execute on function public.set_language_by_token(text, text) from public, service_role;
grant  execute on function public.set_language_by_token(text, text) to anon, authenticated;

commit;
