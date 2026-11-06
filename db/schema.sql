-- 공유 오피스 "모퉁이" DB 스키마 (hw2)
-- 규칙 중 "한 테이블 안에서 확인되는 것"은 DB가 막는다. (DESIGN_LOG.md 3단계)
-- 다른 테이블을 함께 봐야 하는 규칙(정원 초과, 멤버십 기간 밖 예약 등)은 백엔드가 막는다.

create schema if not exists hw2;
create extension if not exists btree_gist;

set search_path = hw2, public;

-- 역할은 enum 타입: 정해진 값 말고는 DB가 타입 단계에서 거절한다.
create type user_role as enum ('customer', 'staff', 'admin');

-- 밖(화면, API, 로그인 토큰)에는 연번 id 대신 public_id(무작위 UUID)만 내보낸다.
-- id(연번)는 DB 안에서 표를 잇는 데만 쓴다. (users, members, reservations)

-- 1. 사용자: 로그인하는 사람 (고객=예약 담당자, 직원, 관리자)
create table users (
  id                   serial primary key,
  public_id            uuid        not null unique default gen_random_uuid(),
  email                text        not null,
  password_hash        text        not null,
  name                 text        not null,
  role                 user_role   not null,
  is_active            boolean     not null default true,
  must_change_password boolean     not null default false,
  created_at           timestamptz not null default now()
);
-- 이메일 중복 불가 (대소문자 무시)
create unique index users_email_unique on users (lower(email));

-- 2. 멤버: 개인 또는 회사
create table members (
  id         serial primary key,
  public_id  uuid        not null unique default gen_random_uuid(),
  type       text        not null check (type in ('individual', 'company')),
  name       text        not null,
  created_at timestamptz not null default now()
);

-- 3. 소속: 어느 사람이 어느 멤버에 언제부터 언제까지 속했는지
--    한 사람은 같은 기간에 한 곳에만 속한다.
create table member_users (
  id         serial primary key,
  user_id    integer not null references users (id),
  member_id  integer not null references members (id),
  start_date date    not null,
  end_date   date,
  check (end_date is null or end_date >= start_date),
  constraint member_users_one_place_at_a_time exclude using gist (
    user_id with =,
    daterange(start_date, coalesce(end_date + 1, 'infinity'::date), '[)') with &&
  )
);

-- 4. 멤버십 종류
create table plans (
  id            serial primary key,
  name          text    not null unique,
  monthly_fee   integer not null check (monthly_fee >= 0),
  monthly_hours integer not null check (monthly_hours > 0)
);

-- 5. 멤버십: 멤버가 어떤 종류로 언제부터 언제까지 가입했는지 (변경하면 줄이 늘어남)
--    한 멤버는 같은 기간에 멤버십 하나만 가진다.
create table memberships (
  id         serial primary key,
  member_id  integer not null references members (id),
  plan_id    integer not null references plans (id),
  start_date date    not null,
  end_date   date    not null,
  check (end_date >= start_date),
  constraint memberships_one_at_a_time exclude using gist (
    member_id with =,
    daterange(start_date, end_date + 1, '[)') with &&
  )
);

-- 6. 회의실
create table meeting_rooms (
  id         serial primary key,
  name       text    not null unique,
  max_people integer not null check (max_people > 0),
  has_video  boolean not null default false
);

-- 7. 자리 / 자리 배정 (고정석)
create table seats (
  id      serial primary key,
  seat_no text not null unique
);

create table seat_assignments (
  id         serial primary key,
  seat_id    integer not null references seats (id),
  member_id  integer not null references members (id),
  start_date date    not null,
  end_date   date,
  check (end_date is null or end_date >= start_date),
  constraint seat_assignments_no_overlap exclude using gist (
    seat_id with =,
    daterange(start_date, coalesce(end_date + 1, 'infinity'::date), '[)') with &&
  )
);

-- 8. 예약
create table reservations (
  id                serial primary key,
  public_id         uuid    not null unique default gen_random_uuid(),
  meeting_room_id   integer not null references meeting_rooms (id),
  user_id           integer not null references users (id),
  reserved_date     date    not null,
  start_time        time    not null,
  end_time          time    not null,
  people_count      integer not null check (people_count > 0),
  status            text    not null default 'reserved'
                    check (status in ('reserved', 'completed', 'cancelled', 'no_show')),
  checked_in_at     timestamptz,
  cancelled_at      timestamptz,
  corrected_by      integer references users (id),
  correction_reason text,
  created_at        timestamptz not null default now(),
  -- 끝 시각은 시작 시각보다 늦어야 한다
  check (end_time > start_time),
  -- 예약은 08:00~22:00 안에서만
  check (start_time >= time '08:00' and end_time <= time '22:00'),
  -- 30분 단위
  check (extract(minute from start_time)::int % 30 = 0 and extract(minute from end_time)::int % 30 = 0),
  -- 같은 회의실은 같은 시간에 두 번 예약할 수 없다 (취소된 예약은 제외)
  constraint reservations_no_double_booking exclude using gist (
    meeting_room_id with =,
    tsrange(reserved_date + start_time, reserved_date + end_time) with &&
  ) where (status <> 'cancelled')
);

-- 9. 차감 기록: 예약 하나가 어느 멤버십의 시간을 몇 분 뺐는지 (한 예약이 여러 줄일 수 있음)
create table usage_records (
  id             serial primary key,
  reservation_id integer not null references reservations (id),
  membership_id  integer not null references memberships (id),
  minutes        integer not null check (minutes >= 0)
);

create index reservations_user_idx on reservations (user_id, reserved_date);
create index usage_records_reservation_idx on usage_records (reservation_id);
create index usage_records_membership_idx on usage_records (membership_id);
