-- DB 규칙 검증용: 모두 마지막에 rollback되어 데이터가 남지 않는다.
-- 사용: psql "$DATABASE_URL" -f db/rule_tests.sql
\set ON_ERROR_STOP off
\set VERBOSITY terse
set search_path = hw2, public;
begin;
insert into users (id,email,password_hash,name,role) values (9001,'a@test.com','x','가','customer'),(9002,'b@test.com','x','나','customer');
insert into members (id,type,name) values (9001,'individual','가'),(9002,'company','A회사');
insert into member_users (user_id,member_id,start_date,end_date) values (9001,9001,'2026-11-01',null);
insert into memberships (member_id,plan_id,start_date,end_date) values (9001,1,'2026-11-20','2026-12-19');
insert into seat_assignments (seat_id,member_id,start_date,end_date) values (1,9001,'2026-11-01','2026-12-31');
insert into reservations (meeting_room_id,user_id,reserved_date,start_time,end_time,people_count) values (2,9001,'2026-12-01','14:00','16:00',4);

\echo '1) 이메일 중복(대소문자 달라도)'
savepoint s; insert into users (email,password_hash,name,role) values ('A@TEST.com','x','다','customer'); rollback to s;
\echo '2) 허용되지 않은 역할 값'
savepoint s; insert into users (email,password_hash,name,role) values ('c@test.com','x','라','boss'); rollback to s;
\echo '3) 같은 회의실 겹치는 시간 예약'
savepoint s; insert into reservations (meeting_room_id,user_id,reserved_date,start_time,end_time,people_count) values (2,9002,'2026-12-01','15:00','17:00',3); rollback to s;
\echo '4) 끝 시각이 시작 시각보다 빠름'
savepoint s; insert into reservations (meeting_room_id,user_id,reserved_date,start_time,end_time,people_count) values (3,9002,'2026-12-01','16:00','15:00',3); rollback to s;
\echo '5) 22시 이후 예약'
savepoint s; insert into reservations (meeting_room_id,user_id,reserved_date,start_time,end_time,people_count) values (3,9002,'2026-12-01','21:00','23:00',3); rollback to s;
\echo '6) 30분 단위가 아님'
savepoint s; insert into reservations (meeting_room_id,user_id,reserved_date,start_time,end_time,people_count) values (3,9002,'2026-12-01','10:10','11:00',3); rollback to s;
\echo '7) 같은 자리에 기간이 겹치는 배정'
savepoint s; insert into seat_assignments (seat_id,member_id,start_date,end_date) values (1,9002,'2026-12-15','2027-01-31'); rollback to s;
\echo '8) 한 사람이 같은 기간에 두 곳 소속'
savepoint s; insert into member_users (user_id,member_id,start_date,end_date) values (9001,9002,'2026-11-15',null); rollback to s;
\echo '9) 한 멤버가 같은 기간에 멤버십 두 개'
savepoint s; insert into memberships (member_id,plan_id,start_date,end_date) values (9001,3,'2026-12-01','2027-01-10'); rollback to s;

\echo '--- 대조: 취소된 예약은 같은 시간 재예약 가능 ---'
update reservations set status='cancelled' where meeting_room_id=2 and reserved_date='2026-12-01';
insert into reservations (meeting_room_id,user_id,reserved_date,start_time,end_time,people_count) values (2,9002,'2026-12-01','14:00','16:00',3);
\echo '(성공)'
\echo '--- 대조: DB가 못 막는 것 — 정원 6명 방에 20명 ---'
insert into reservations (meeting_room_id,user_id,reserved_date,start_time,end_time,people_count) values (2,9002,'2026-12-02','10:00','11:00',20);
\echo '(들어감: 정원은 백엔드가 막는다)'
rollback;
