-- The household as it is on the live v1 database (before migration 0002), all fictional:
-- three people who sign in, two contractors and the kitchen project (shared, with a private note).
-- Loaded after schema.sql and before the migrations, so the migration's own seeding (one person per
-- member) runs on it, as it will on the real database. psql variable :kitchen holds
-- supabase/kitchen-renovation.json (run.sh sets it).
insert into members (email, name, role, created_at) values
  ('alex@example.com',   'Alex Example',   'admin',  '2026-10-01 12:00+00'),
  ('morgan@example.com', 'Morgan Example', 'admin',  '2026-10-01 12:01+00'),
  ('sam@example.com',    'Sam Example',    'member', '2026-10-01 12:02+00');

insert into contractors (id, name, company, trade, phone, email, website, notes) values
  ('c0000000-0000-4000-8000-000000000001', 'Pat Lee', 'Lee Electric', 'Electrician', '(201) 555-0100',
   'pat@leeelectric.example', 'leeelectric.example', 'Licensed master electrician.'),
  ('c0000000-0000-4000-8000-000000000002', 'Maria Gomez', 'Gomez Tile & Stone', 'Tile', '(201) 555-0101', null, null, null);

-- The kitchen schedule starts on Monday Oct 26, so the design consult is under way on Tue Oct 27
-- (the harness's "today"); the electrician trade is Pat Lee; the first task has a private note.
insert into projects (id, name, status, summary, sharing_enabled, share_token, schedule) values
  ('a0000000-0000-4000-8000-000000000001', 'Kitchen Renovation', 'active', 'Cabinets, counters, tile, floors and paint.', true,
   'kitchentoken0123456789ab',
   jsonb_set(jsonb_set(jsonb_set(:'kitchen'::jsonb, '{project,start}', '"2026-10-26"'),
             '{trades,electrician,contractor_id}', '"c0000000-0000-4000-8000-000000000001"'),
             '{phases,0,tasks,0,private_notes}', '"Side gate code 4821"')),
  ('a0000000-0000-4000-8000-000000000002', 'Pool repairs', 'planning', 'New pump and plaster patch before summer.', false,
   'pooltoken0123456789abcde', '{"project": {"start": "2027-03-01", "holidays": []}, "trades": {}, "phases": []}');
