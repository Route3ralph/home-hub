-- A household as it is before migration 0002: two members, a contractor and a shared project.
-- Loaded after schema.sql and before the migrations, so the migration's seeding is tested too.
insert into members (email, name, role) values
  ('alex@example.com', 'Alex', 'admin'),
  ('sam@example.com', 'Sam', 'member');
insert into contractors (id, name, company, phone, email) values
  ('11111111-1111-1111-1111-111111111111', 'Pat Lee', 'Lee Electric', '555-0100', 'pat@lee.example');
insert into projects (name, sharing_enabled, share_token, schedule) values ('Kitchen', true, 'aaaaaaaaaaaaaaaaaaaaaaaa',
  '{"project": {"start": "2026-11-02"},
    "trades": {"electrician": {"name": "Electrician", "contractor_id": "11111111-1111-1111-1111-111111111111"}},
    "phases": [{"name": "P1", "tasks": [{"id": "a", "name": "Wire", "trade": "electrician", "days": 2, "private_notes": "gate 1234"}]}]}');
