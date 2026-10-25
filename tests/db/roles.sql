-- Who the next statements run as. Use one on its own line, e.g. ":as_admin".
-- The claims are what PostgREST would set for that request; auth.jwt() reads them.
--   anon      signed out (the share page, My day)
--   stranger  signed in, not on the family list
--   removed   signed in, has a parent row in people, but no longer in members
--   adult     a member (Sam, adult)
--   admin     an admin (Alex, parent)
--   service   the hub-jobs function (service_role key)
--   owner     the database owner, for setting up data
\set as_anon     'reset role; set request.jwt.claims = ''{"role": "anon"}''; set role anon;'
\set as_stranger 'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "casey@example.com"}''; set role authenticated;'
\set as_removed  'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "jordan@example.com"}''; set role authenticated;'
\set as_adult    'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "sam@example.com"}''; set role authenticated;'
\set as_admin    'reset role; set request.jwt.claims = ''{"role": "authenticated", "email": "alex@example.com"}''; set role authenticated;'
\set as_service  'reset role; set request.jwt.claims = ''{"role": "service_role"}''; set role service_role;'
\set as_owner    'reset role; set request.jwt.claims = '''';'
