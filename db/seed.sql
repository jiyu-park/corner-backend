-- 가상 기본 데이터 (실제 정보 아님). 관리자 계정은 `npm run seed:admin`으로 따로 만든다.
set search_path = hw2, public;

insert into plans (name, monthly_fee, monthly_hours) values
  ('자유석', 150000, 4),
  ('고정석', 300000, 10),
  ('오피스', 600000, 20)
on conflict (name) do nothing;

insert into meeting_rooms (name, max_people, has_video) values
  ('소회의실 A', 4, false),
  ('회의실 B', 6, true),
  ('회의실 C', 8, false),
  ('대회의실 D', 12, true)
on conflict (name) do nothing;

insert into seats (seat_no) values
  ('101'), ('102'), ('103'), ('104'), ('105'), ('106')
on conflict (seat_no) do nothing;
