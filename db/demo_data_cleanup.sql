-- 가상 데이터(db/demo_data.mjs)만 지운다. 체험용 계정(demo-customer, demo-staff)과 관리자는 지우지 않는다.
set search_path = hw2, public;
begin;
create temp table t_users as select id from users where email like '%@demo.corner.test';
create temp table t_members as
  select id from members where name like '%(가상)'
  union select member_id from member_users where user_id in (select id from t_users);
delete from usage_records where reservation_id in (select id from reservations where user_id in (select id from t_users));
delete from reservations where user_id in (select id from t_users);
delete from seat_assignments where member_id in (select id from t_members);
delete from usage_records where membership_id in (select id from memberships where member_id in (select id from t_members));
delete from memberships where member_id in (select id from t_members);
delete from member_users where user_id in (select id from t_users) or member_id in (select id from t_members);
delete from members where id in (select id from t_members);
delete from users where id in (select id from t_users);
commit;
