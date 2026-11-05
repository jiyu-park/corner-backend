import { PoolClient } from 'pg';
import { BadRequestException } from '@nestjs/common';
import { query, q } from './db';
import { addDays, cycleFor } from './dates';


export type Runner = (sql: string, params?: unknown[]) => Promise<any[]>;
export const runner = (c?: PoolClient): Runner =>
  c ? (s, p = []) => q(c, s, p) : (s, p = []) => query(s, p);

export const OVERAGE_PER_HOUR = 15000;

/**
 * 주기의 기준일(가입일). 멤버십이 끊기지 않고 이어지는 묶음의 첫 시작일.
 * (멤버십을 올려서 줄이 나뉘어도 같은 주기로 본다. 결정 14, 15)
 */
export async function anchorFor(R: Runner, memberId: number, date: string): Promise<string> {
  const rows = await R(
    'select start_date, end_date from memberships where member_id = $1 order by start_date',
    [memberId],
  );
  let chainStart: string | null = null;
  let prevEnd: string | null = null;
  let found: string | null = null;
  for (const r of rows) {
    if (chainStart === null || prevEnd === null || r.start_date !== addDays(prevEnd, 1)) chainStart = r.start_date;
    if (r.start_date <= date && r.end_date >= date) found = chainStart;
    prevEnd = r.end_date;
  }
  return found ?? (rows[0]?.start_date as string);
}


export interface Wallet {
  membership_id: number;
  member_id: number;
  member_name: string;
  member_type: 'individual' | 'company';
  plan_name: string;
  plan_fee: number;
  cycle_start: string;
  cycle_end: string;
  total_minutes: number; // 이 주기에 쓸 수 있는 시간(분)
  used_minutes: number; // 이 주기에 이미 차감된 시간(분)
  remaining_minutes: number; // 음수이면 초과
}

/**
 * 사용자가 그 날짜에 쓸 수 있는 "시간 지갑" 목록. (결정 14, 20)
 * - 개인 멤버십이 먼저, 회사 멤버십이 나중. (개인 시간부터 소진)
 * - 회사 멤버십은 그날 그 회사에 소속된 경우에만.
 * - 개인 멤버십은 소속이 끝났어도 그 멤버십 기간이 남아 있으면 유지.
 */
export async function getWallets(userId: number, date: string, c?: PoolClient): Promise<Wallet[]> {
  const R = runner(c);
  const rows = await R(
    `select m.id as membership_id, mb.id as member_id, mb.name as member_name, mb.type as member_type,
            p.name as plan_name, p.monthly_fee as plan_fee, p.monthly_hours
       from memberships m
       join members mb on mb.id = m.member_id
       join plans p on p.id = m.plan_id
      where m.start_date <= $2 and m.end_date >= $2
        and (
          (mb.type = 'individual' and exists (select 1 from member_users mu where mu.member_id = mb.id and mu.user_id = $1))
          or exists (select 1 from member_users mu
                      where mu.member_id = mb.id and mu.user_id = $1
                        and mu.start_date <= $2 and (mu.end_date is null or mu.end_date >= $2))
        )
      order by (mb.type = 'individual') desc, m.start_date`,
    [userId, date],
  );

  const wallets: Wallet[] = [];
  for (const r of rows) {
    const anchor = await anchorFor(R, r.member_id, date);
    const cyc = cycleFor(anchor, date);
    const used = await usedMinutes(R, r.member_id, cyc.start, cyc.end);
    const total = r.monthly_hours * 60;
    wallets.push({
      membership_id: r.membership_id,
      member_id: r.member_id,
      member_name: r.member_name,
      member_type: r.member_type,
      plan_name: r.plan_name,
      plan_fee: r.plan_fee,
      cycle_start: cyc.start,
      cycle_end: cyc.end,
      total_minutes: total,
      used_minutes: used.total,
      remaining_minutes: total - used.total,
    });
  }
  return wallets;
}

/** 멤버가 한 주기 동안 차감한 시간. core = 예약됨·사용 완료, penalty = 노쇼·늦은 취소 */
export async function usedMinutes(R: Runner, memberId: number, from: string, to: string) {
  const rows = await R(
    `select coalesce(sum(ur.minutes) filter (where r.status in ('reserved','completed')), 0)::int as core,
            coalesce(sum(ur.minutes) filter (where r.status in ('no_show','cancelled')), 0)::int as penalty
       from usage_records ur
       join reservations r on r.id = ur.reservation_id
       join memberships m on m.id = ur.membership_id
      where m.member_id = $1 and r.reserved_date between $2 and $3`,
    [memberId, from, to],
  );
  const core = rows[0].core as number;
  const penalty = rows[0].penalty as number;
  return { core, penalty, total: core + penalty };
}

/**
 * 예약 시간을 지갑에서 차감한다. (결정 20)
 * 개인 지갑부터 쓰고, 모자라면 다음 지갑(회사)에서 차감한다.
 * 모두 모자라면 남은 시간은 마지막 지갑에 초과로 기록하고 과금한다. (결정 3)
 */
export async function allocateUsage(
  c: PoolClient,
  reservationId: number,
  userId: number,
  date: string,
  minutes: number,
) {
  const wallets = await getWallets(userId, date, c);
  if (wallets.length === 0) {
    throw new BadRequestException('이 날짜에는 이용할 수 있는 멤버십이 없어요. 멤버십을 신청하거나 연장해 주세요.');
  }
  let need = minutes;
  const parts: { membership_id: number; member_name: string; minutes: number }[] = [];
  for (const w of wallets) {
    if (need <= 0) break;
    const take = Math.min(Math.max(0, w.remaining_minutes), need);
    if (take > 0) {
      parts.push({ membership_id: w.membership_id, member_name: w.member_name, minutes: take });
      need -= take;
    }
  }
  let overage = 0;
  if (need > 0) {
    const last = wallets[wallets.length - 1];
    parts.push({ membership_id: last.membership_id, member_name: last.member_name, minutes: need });
    overage = need;
  }
  for (const p of parts) {
    await q(c, 'insert into usage_records (reservation_id, membership_id, minutes) values ($1,$2,$3)', [
      reservationId,
      p.membership_id,
      p.minutes,
    ]);
  }
  return { parts, overage_minutes: overage };
}

/**
 * 노쇼·늦은 취소 차감. (결정 6, 12, 13)
 * 그 사람의 첫 위반은 0%, 두 번째부터 50%. 정정된 것은 횟수에서 제외한다.
 */
export async function applyPenalty(c: PoolClient, reservationId: number, userId: number) {
  const prior = await q(
    c,
    `select count(*)::int as n from reservations r
      where r.user_id = $1 and r.id <> $2 and r.corrected_by is null
        and (r.status = 'no_show'
             or (r.status = 'cancelled'
                 and (r.cancelled_at at time zone 'Asia/Seoul') > (r.reserved_date + r.start_time) - interval '1 hour'))`,
    [userId, reservationId],
  );
  const pct = prior[0].n === 0 ? 0 : 0.5;
  await q(c, 'update usage_records set minutes = floor(minutes * $2::numeric)::int where reservation_id = $1', [
    reservationId,
    pct,
  ]);
  return { percent: pct * 100, first_violation: prior[0].n === 0 };
}

/** 불이익 없이 취소: 차감 기록을 지운다. (정상 취소, 퇴사·해지 자동 취소, 직원 정정) */
export async function releaseUsage(c: PoolClient, reservationId: number) {
  await q(c, 'delete from usage_records where reservation_id = $1', [reservationId]);
}

/** 해당 날짜(이후)에 남은 앞으로 예약을 불이익 없이 취소한다. (결정 17, 18, 23) */
export async function cancelFutureReservations(
  c: PoolClient,
  userIds: number[],
  fromDate: string,
  nowTime: string,
  byUserId: number,
  reason: string,
) {
  if (userIds.length === 0) return [];
  const rows = await q(
    c,
    `select id from reservations
      where user_id = any($1::int[]) and status = 'reserved'
        and (reserved_date > $2 or (reserved_date = $2 and start_time > $3::time))`,
    [userIds, fromDate, nowTime],
  );
  for (const r of rows) {
    await q(
      c,
      `update reservations set status = 'cancelled', cancelled_at = now(), corrected_by = $2, correction_reason = $3 where id = $1`,
      [r.id, byUserId, reason],
    );
    await releaseUsage(c, r.id);
  }
  return rows.map((r) => r.id as number);
}

/** 멤버의 주기·요금·초과 계산 (D4). 노쇼로 생긴 초과분은 과금하지 않는다. (결정 8) */
export async function billingFor(memberId: number, date: string) {
  const rows = await query(
    `select m.id as membership_id, m.start_date, m.end_date, p.name as plan_name,
            p.monthly_fee, p.monthly_hours
       from memberships m join plans p on p.id = m.plan_id
      where m.member_id = $1 and m.start_date <= $2 and m.end_date >= $2`,
    [memberId, date],
  );
  if (rows.length === 0) return null;
  const m = rows[0];
  const anchor = await anchorFor(runner(), memberId, date);
  const cyc = cycleFor(anchor, date);
  const used = await usedMinutes(runner(), memberId, cyc.start, cyc.end);
  const quota = m.monthly_hours * 60;
  const billableOverage = Math.max(0, used.core - quota);
  const overageAmount = Math.round((billableOverage / 60) * OVERAGE_PER_HOUR);
  return {
    plan_name: m.plan_name,
    cycle_start: cyc.start,
    cycle_end: cyc.end,
    quota_minutes: quota,
    used_minutes: used.total,
    used_core_minutes: used.core,
    penalty_minutes: used.penalty,
    overage_minutes_billed: billableOverage,
    overage_minutes_waived: Math.max(0, used.total - quota) - billableOverage,
    plan_fee: m.monthly_fee,
    overage_amount: overageAmount,
    total_amount: m.monthly_fee + overageAmount,
  };
}

export { addDays };
