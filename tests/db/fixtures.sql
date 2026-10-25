-- A small v2 household for the tests (all fictional). Include after roles.sql.
-- Already there from v1_data.sql and the migration's seeding:
--   Alex (parent, admin, alex@example.com), Sam (adult, member, sam@example.com),
--   Pat Lee (contractor), the Kitchen project.
-- Added here:
--   Jordan  parent with jordan@example.com, but no longer in members (a removed member)
--   Taylor  kid, no email
--   Morgan  helper, Spanish, morgan@example.com
--   Rivera Music (a service) and City Water (an account with an account number)
:as_owner
update people set phone = '555-0101' where name = 'Alex';
insert into people (name, role, email, phone, language, sort_order) values
  ('Jordan', 'parent', 'jordan@example.com', '555-0102', 'en', 2),
  ('Taylor', 'kid', null, '555-0103', 'en', 3),
  ('Morgan', 'helper', 'morgan@example.com', '555-0104', 'es', 4);
insert into contractors (name, company, phone, kind) values
  ('Rivera Music', 'Rivera Music', '555-0150', 'service'),
  ('City Water', null, '555-0160', 'account');
insert into contractor_secrets (contractor_id, account_number, account_name)
values (test.contractor('City Water'), '0000-1111-2222', 'Alex Example');
