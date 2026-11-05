-- DBeaver 실습용 (4-2): 웹앱을 거치지 않고 DB에 직접 넣어 본다.
-- 한 문장씩 실행: 문장에 커서를 두고 Cmd+Enter. 여러 문장을 한 번에: Option+X (스크립트 실행).
-- 아래 1~3번은 데이터가 남지 않는다. (거절되거나 rollback)

-- ① 웹앱에서 넣은 데이터가 hw2에 저장됐는지 확인
select id, email, role, name from hw2.users order by id;
select id, meeting_room_id, user_id, reserved_date, start_time, end_time, people_count, status from hw2.reservations order by id;

-- ② 비밀번호가 DB에 어떤 모양으로 저장됐는지 (앞 7글자만 보이게 가림)
select email, role, left(password_hash, 7) || '…' as password_hash_앞부분, length(password_hash) as 길이 from hw2.users order by id;

-- ③ DB가 막는 규칙: 아래를 한 문장씩 실행하고, 오류가 나는 화면을 캡처한다.
-- 3-1) 이메일 중복 (대소문자만 달라도)
insert into hw2.users (email, password_hash, name, role) values ('DEMO-CUSTOMER@corner.test', 'x', '가짜', 'customer');

-- 3-2) 허용되지 않은 역할 값
insert into hw2.users (email, password_hash, name, role) values ('boss@corner.test', 'x', '가짜', 'boss');

-- 3-3) 같은 회의실 같은 시간 겹침 (소회의실 A 11/06 10:00~11:00 예약과 겹침)
insert into hw2.reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count)
values (1, (select id from hw2.users where email = 'demo-customer@corner.test'), '2026-11-06', '10:30', '11:30', 2);

-- 3-4) 끝 시각이 시작 시각보다 빠름
insert into hw2.reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count)
values (2, (select id from hw2.users where email = 'demo-customer@corner.test'), '2026-12-01', '12:00', '11:00', 2);

-- 3-5) 22시 이후 예약
insert into hw2.reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count)
values (2, (select id from hw2.users where email = 'demo-customer@corner.test'), '2026-12-01', '21:00', '23:00', 2);

-- 3-6) 30분 단위가 아님
insert into hw2.reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count)
values (2, (select id from hw2.users where email = 'demo-customer@corner.test'), '2026-12-01', '10:10', '11:00', 2);

-- ④ DB가 못 막는 규칙: 막히지 않고 들어가 버린다. (백엔드가 막아야 하는 규칙)
--    Option+X 로 전체를 한 번에 실행. 마지막에 rollback 해서 데이터는 남지 않는다.
begin;
-- 4-1) 정원 초과: 소회의실 A는 최대 4명인데 20명
insert into hw2.reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count)
values (1, (select id from hw2.users where email = 'demo-customer@corner.test'), '2026-12-01', '13:00', '14:00', 20);
-- 4-2) 멤버십 기간 밖 날짜 (멤버십이 없는 2027년)
insert into hw2.reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count)
values (1, (select id from hw2.users where email = 'demo-customer@corner.test'), '2027-03-01', '10:00', '11:00', 2);
-- 들어간 것을 확인
select r.id, mr.name as 회의실, mr.max_people as 정원, r.people_count as 신청인원, r.reserved_date
  from hw2.reservations r join hw2.meeting_rooms mr on mr.id = r.meeting_room_id
 where r.people_count > mr.max_people or r.reserved_date >= '2027-01-01';
rollback;

-- 혹시 위 rollback 전에 멈췄다면 아래로 정리한다.
-- delete from hw2.reservations where reserved_date in ('2026-12-01', '2027-03-01') and people_count in (20, 2) and created_at > now() - interval '1 hour';
