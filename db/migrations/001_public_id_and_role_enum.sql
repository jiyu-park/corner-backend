-- 이미 운영 중인 DB를 새 스키마로 바꾸는 변환 SQL (한 번만 실행, 여러 번 실행해도 안전)
--  1) users.role: text + check 제약 → enum 타입 user_role
--  2) users, members, reservations에 외부용 public_id(무작위 UUID) 추가
-- 기존 행의 public_id는 열을 더할 때 행마다 서로 다른 값으로 자동 채워진다.
-- 사용: psql "$DATABASE_URL" -f db/migrations/001_public_id_and_role_enum.sql

begin;
set local search_path = hw2, public;

-- 1. 역할 enum
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where t.typname = 'user_role' and n.nspname = 'hw2'
  ) then
    create type hw2.user_role as enum ('customer', 'staff', 'admin');
  end if;
end $$;

alter table hw2.users drop constraint if exists users_role_check;
alter table hw2.users alter column role type hw2.user_role using role::text::hw2.user_role;

-- 2. 외부용 공개 ID
alter table hw2.users        add column if not exists public_id uuid not null default gen_random_uuid();
alter table hw2.members      add column if not exists public_id uuid not null default gen_random_uuid();
alter table hw2.reservations add column if not exists public_id uuid not null default gen_random_uuid();

create unique index if not exists users_public_id_key        on hw2.users (public_id);
create unique index if not exists members_public_id_key      on hw2.members (public_id);
create unique index if not exists reservations_public_id_key on hw2.reservations (public_id);

commit;
