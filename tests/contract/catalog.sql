-- What the site can reach in the migrated database, as one JSON document for check.js:
--   functions: every function in public, with its input argument names in order, how many of
--              them are required (the rest have defaults), and who may execute it;
--   tables:    every table and view in public, and whether each API role has any rights on it.
select json_build_object(
  'functions', coalesce((
    select json_agg(json_build_object(
             'name', p.proname,
             'args', coalesce((
               select json_agg(coalesce(a.name, '') order by a.ord)
               from unnest(coalesce(p.proargnames, array_fill(''::text, array[p.pronargs])),
                           coalesce(p.proargmodes, array_fill('i'::"char", array[p.pronargs])))
                    with ordinality a (name, mode, ord)
               where a.mode in ('i', 'b', 'v')), '[]'),
             'required', p.pronargs - p.pronargdefaults,
             'anon', has_function_privilege('anon', p.oid, 'execute'),
             'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
             'service_role', has_function_privilege('service_role', p.oid, 'execute'))
           order by p.proname, p.oid)
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'), '[]'),
  'tables', coalesce((
    select json_agg(json_build_object(
             'name', c.relname,
             'anon', has_table_privilege('anon', c.oid, 'select, insert, update, delete'),
             'authenticated', has_table_privilege('authenticated', c.oid, 'select, insert, update, delete'),
             'service_role', has_table_privilege('service_role', c.oid, 'select, insert, update, delete'))
           order by c.relname)
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')), '[]'));
