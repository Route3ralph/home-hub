-- After migration 0002 (all fictional). The migration made Alex and Morgan parents and Sam an adult;
-- this adds a kid and a helper, colours and phones, the household's owners for new pet and house
-- tasks, and directory entries: a service and a utility account with an account number.
update people set phone = '(201) 555-0102', color = '#2563eb' where email = 'alex@example.com';
update people set phone = '(201) 555-0105', color = '#9333ea' where email = 'morgan@example.com';
update people set phone = '(201) 555-0106', color = '#db2777' where email = 'sam@example.com';
insert into people (id, name, role, phone, color, language, sort_order) values
  ('b0000000-0000-4000-8000-000000000004', 'Jordan Example', 'kid',    '(201) 555-0103', '#16a34a', 'en', 3),
  ('b0000000-0000-4000-8000-000000000005', 'Taylor Example', 'helper', '(201) 555-0104', '#ca8a04', 'es', 4);
update household set pets_owner_id = 'b0000000-0000-4000-8000-000000000005',
                     house_owner_id = (select id from people where email = 'sam@example.com');

insert into contractors (id, name, company, phone, kind, category) values
  ('c0000000-0000-4000-8000-000000000003', 'Rivera Music', 'Rivera Music', '(201) 555-0150', 'service', 'Lessons'),
  ('c0000000-0000-4000-8000-000000000004', 'Example Water Co', null, '(201) 555-0160', 'account', 'Water');
insert into contractor_secrets (contractor_id, account_number, account_name) values
  ('c0000000-0000-4000-8000-000000000004', '5555 0101 9876', 'Alex Example');
