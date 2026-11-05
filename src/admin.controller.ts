import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { AuthUser, CurrentUser, Roles } from './auth';
import { q, query, tx } from './db';
import { cycleFor, isYMD, monthRange, nowKST } from './dates';
import { applyPenalty, billingFor, cancelFutureReservations, getWallets, releaseUsage, runner } from './core';

const tempPassword = () => `Tmp-${randomBytes(5).toString('hex')}`;

@Roles('staff', 'admin')
@Controller('admin')
export class AdminController {
  // ───────── 예약 현황 / 사용 시작 / 노쇼 전환 / 정정 (D2) ─────────
  @Get('reservations')
  reservations(@Query('date') date?: string) {
    const d = date && isYMD(date) ? date : nowKST().date;
    return query(
      `select r.id, r.reserved_date, to_char(r.start_time,'HH24:MI') as start_time, to_char(r.end_time,'HH24:MI') as end_time,
              r.people_count, r.status, r.checked_in_at, r.cancelled_at, r.correction_reason,
              mr.name as room_name, u.id as user_id, u.name as user_name,
              (select mb.name from member_users mu join members mb on mb.id = mu.member_id
                where mu.user_id = u.id and mu.start_date <= r.reserved_date
                  and (mu.end_date is null or mu.end_date >= r.reserved_date)) as member_name,
              coalesce((select sum(minutes) from usage_records where reservation_id = r.id), 0)::int as charged_minutes
         from reservations r
         join meeting_rooms mr on mr.id = r.meeting_room_id
         join users u on u.id = r.user_id
        where r.reserved_date = $1
        order by mr.id, r.start_time`,
      [d],
    );
  }

  // 사용 시작: 늦게 와도 인정하지만 끝나는 시각은 그대로다. (결정 9)
  @Post('reservations/:id/check-in')
  async checkIn(@Param('id', ParseIntPipe) id: number) {
    const [r] = await query(
      `update reservations set checked_in_at = now()
        where id = $1 and status = 'reserved' and checked_in_at is null
        returning id, to_char(end_time,'HH24:MI') as end_time`,
      [id],
    );
    if (!r) throw new BadRequestException('사용 시작을 누를 수 없는 예약이에요.');
    return { ok: true, message: `사용을 시작했어요. 늦게 시작해도 종료는 ${r.end_time}로 그대로예요.` };
  }

  @Post('reservations/:id/complete')
  async complete(@Param('id', ParseIntPipe) id: number) {
    const [r] = await query(
      `update reservations set status = 'completed'
        where id = $1 and status = 'reserved' and checked_in_at is not null returning id`,
      [id],
    );
    if (!r) throw new BadRequestException('사용 시작을 누른 예약만 사용 완료로 바꿀 수 있어요.');
    return { ok: true };
  }

  // 시작 후 15분이 지나도 사용 시작을 안 누른 예약을 노쇼로 바꾼다. (D2)
  // as_of는 발표 시연용: 그 시각이 "지금"이라고 가정하고 계산한다.
  @Post('reservations/mark-no-shows')
  async markNoShows(@Body() body: { as_of?: string }) {
    const now = nowKST(body?.as_of).ts;
    return tx(async (c) => {
      const rows = await q(
        c,
        `select id, user_id from reservations
          where status = 'reserved' and checked_in_at is null
            and (reserved_date + start_time) + interval '15 minutes' < $1::timestamp
          order by reserved_date, start_time for update`,
        [now],
      );
      const out: any[] = [];
      for (const r of rows) {
        await q(c, `update reservations set status = 'no_show' where id = $1`, [r.id]);
        const p = await applyPenalty(c, r.id, r.user_id);
        out.push({ id: r.id, percent: p.percent, first_violation: p.first_violation });
      }
      return { now, changed: out.length, reservations: out };
    });
  }

  // 억울한 노쇼·늦은 취소를 직원이 정정한다. 처리자와 사유를 남기고 차감을 되돌린다. (결정 10, 11)
  @Post('reservations/:id/correct')
  async correct(
    @CurrentUser() staff: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { reason?: string },
  ) {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('정정 사유를 적어 주세요.');
    return tx(async (c) => {
      const [r] = await q(c, 'select id, status, corrected_by from reservations where id = $1 for update', [id]);
      if (!r) throw new NotFoundException('없는 예약이에요.');
      if (r.corrected_by) throw new BadRequestException('이미 정정된 예약이에요.');
      if (!['no_show', 'cancelled'].includes(r.status)) {
        throw new BadRequestException('노쇼 또는 취소된 예약만 정정할 수 있어요.');
      }
      await q(
        c,
        `update reservations set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()),
                corrected_by = $2, correction_reason = $3 where id = $1`,
        [id, staff.id, reason],
      );
      await releaseUsage(c, id);
      return { ok: true, message: '정정했어요. 차감된 시간을 돌려드렸고, 첫 면제 횟수에도 포함되지 않아요.' };
    });
  }

  // ───────── 멤버 / 청구 (D4) ─────────
  @Get('members')
  async members() {
    const today = nowKST().date;
    const members = await query('select id, type, name from members order by id');
    const out: any[] = [];
    for (const m of members) {
      const users = await query(
        `select u.id, u.name, u.email, mu.id as member_user_id, mu.start_date, mu.end_date
           from member_users mu join users u on u.id = mu.user_id
          where mu.member_id = $1 and mu.start_date <= $2 and (mu.end_date is null or mu.end_date >= $2)
          order by u.name`,
        [m.id, today],
      );
      const [ms] = await query(
        `select ms.id, p.name as plan_name, ms.start_date, ms.end_date
           from memberships ms join plans p on p.id = ms.plan_id
          where ms.member_id = $1 and ms.end_date >= $2 order by ms.start_date limit 1`,
        [m.id, today],
      );
      out.push({ ...m, users, membership: ms ?? null, billing: await billingFor(m.id, today) });
    }
    return out;
  }

  @Get('billing')
  async billing(@Query('member_id') memberId: string, @Query('date') date?: string) {
    const id = Number(memberId);
    if (!id) throw new BadRequestException('멤버를 골라 주세요.');
    const d = date && isYMD(date) ? date : nowKST().date;
    const b = await billingFor(id, d);
    if (!b) throw new NotFoundException('그 날짜에 이용 중인 멤버십이 없어요.');
    return b;
  }

  @Get('customers')
  customers() {
    const today = nowKST().date;
    return query(
      `select u.id, u.name, u.email, u.is_active,
              (select mb.name from member_users mu join members mb on mb.id = mu.member_id
                where mu.user_id = u.id and mu.start_date <= $1 and (mu.end_date is null or mu.end_date >= $1)) as member_name
         from users u where u.role = 'customer' order by u.id desc`,
      [today],
    );
  }

  @Post('members')
  async createCompany(@Body() body: { name?: string }) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('회사 이름을 적어 주세요.');
    const [m] = await query(`insert into members (type, name) values ('company', $1) returning id, type, name`, [name]);
    return m;
  }

  @Post('members/:id/membership')
  async addMembership(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { plan_id?: number; start_date?: string },
  ) {
    const planId = Number(body.plan_id);
    if (!planId) throw new BadRequestException('멤버십 종류를 골라 주세요.');
    const start = body.start_date && isYMD(body.start_date) ? body.start_date : nowKST().date;
    const end = cycleFor(start, start).end;
    const [row] = await query(
      'insert into memberships (member_id, plan_id, start_date, end_date) values ($1,$2,$3,$4) returning *',
      [id, planId, start, end],
    );
    return row;
  }

  // 고객을 회사 멤버에 소속시킨다. 기존 소속은 전날로 끝내고, 개인 멤버십의 남은 시간은 그 주기 끝까지 유지된다. (결정 19, 20)
  @Post('members/:id/users')
  async addUser(@Param('id', ParseIntPipe) memberId: number, @Body() body: { user_id?: number; start_date?: string }) {
    const userId = Number(body.user_id);
    if (!userId) throw new BadRequestException('고객을 골라 주세요.');
    const start = body.start_date && isYMD(body.start_date) ? body.start_date : nowKST().date;
    return tx(async (c) => {
      const [u] = await q(c, `select id from users where id = $1 and role = 'customer'`, [userId]);
      if (!u) throw new NotFoundException('고객 계정이 아니에요.');
      const [cur] = await q(
        c,
        `select id, start_date from member_users
          where user_id = $1 and (end_date is null or end_date >= $2) order by start_date desc limit 1`,
        [userId, start],
      );
      if (cur) {
        const prev = new Date(Date.parse(start) - 86400000).toISOString().slice(0, 10);
        if (cur.start_date >= start) {
          // 오늘 가입한 사람이 오늘 옮기는 경우: 기존 소속을 지우지 않고 전날 하루로 남겨 둔다.
          // (개인 멤버십의 남은 시간을 계속 쓰려면 그 개인 멤버와의 연결이 남아 있어야 한다)
          await q(c, 'update member_users set start_date = $2, end_date = $2 where id = $1', [cur.id, prev]);
        } else {
          await q(c, 'update member_users set end_date = $2 where id = $1', [cur.id, prev]);
        }
      }
      const [row] = await q(
        c,
        'insert into member_users (user_id, member_id, start_date) values ($1,$2,$3) returning *',
        [userId, memberId, start],
      );
      return row;
    });
  }

  // 퇴사 처리 (D3): 소속을 끝내고, 그 직원의 앞으로 예약은 불이익 없이 자동 취소한다. (결정 17, 18)
  @Post('member-users/:id/leave')
  async leave(
    @CurrentUser() staff: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { end_date?: string },
  ) {
    const now = nowKST();
    const end = body?.end_date && isYMD(body.end_date) ? body.end_date : now.date;
    return tx(async (c) => {
      const [mu] = await q(c, 'select * from member_users where id = $1 for update', [id]);
      if (!mu) throw new NotFoundException('없는 소속이에요.');
      if (end < mu.start_date) throw new BadRequestException('퇴사일은 소속 시작일보다 빠를 수 없어요.');
      await q(c, 'update member_users set end_date = $2 where id = $1', [id, end]);
      const cancelled = await cancelFutureReservations(
        c,
        [mu.user_id],
        end,
        end === now.date ? now.time : '23:59:59',
        staff.id,
        '퇴사·소속 종료 처리',
      );
      return {
        ok: true,
        cancelled_reservations: cancelled.length,
        message: `소속을 ${end}에 끝냈어요. 앞으로 예약 ${cancelled.length}건은 불이익 없이 취소하고 시간을 돌려드렸어요.`,
      };
    });
  }

  // 멤버십 해지: 종료일을 앞당기고, 종료일 이후 예약은 같은 규칙으로 자동 취소한다. (결정 23)
  @Post('memberships/:id/terminate')
  async terminate(
    @CurrentUser() staff: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { end_date?: string },
  ) {
    const end = body?.end_date && isYMD(body.end_date) ? body.end_date : nowKST().date;
    return tx(async (c) => {
      const [m] = await q(c, 'select * from memberships where id = $1 for update', [id]);
      if (!m) throw new NotFoundException('없는 멤버십이에요.');
      if (end < m.start_date || end > m.end_date) throw new BadRequestException('종료일은 멤버십 기간 안이어야 해요.');
      await q(c, 'update memberships set end_date = $2 where id = $1', [id, end]);
      const rows = await q(
        c,
        `select distinct r.id from reservations r join usage_records ur on ur.reservation_id = r.id
          where ur.membership_id = $1 and r.status = 'reserved' and r.reserved_date > $2`,
        [id, end],
      );
      for (const r of rows) {
        await q(
          c,
          `update reservations set status = 'cancelled', cancelled_at = now(), corrected_by = $2, correction_reason = $3 where id = $1`,
          [r.id, staff.id, '멤버십 해지 처리'],
        );
        await releaseUsage(c, r.id);
      }
      return { ok: true, cancelled_reservations: rows.length };
    });
  }

  // ───────── 현황 ─────────
  @Get('memberships/ending')
  endingMemberships(@Query('month') month?: string) {
    const mo = month && /^\d{4}-\d{2}$/.test(month) ? month : nowKST().date.slice(0, 7);
    const { start, end } = monthRange(mo);
    return query(
      `select mb.id as member_id, mb.name as member_name, p.name as plan_name, m.end_date
         from memberships m join members mb on mb.id = m.member_id join plans p on p.id = m.plan_id
        where m.end_date between $1 and $2
          and not exists (select 1 from memberships n where n.member_id = m.member_id and n.start_date > m.end_date)
        order by m.end_date`,
      [start, end],
    );
  }

  @Get('rooms/utilization')
  async utilization(@Query('month') month?: string) {
    const mo = month && /^\d{4}-\d{2}$/.test(month) ? month : nowKST().date.slice(0, 7);
    const { start, end, days } = monthRange(mo);
    const rows = await query(
      `select mr.id, mr.name,
              coalesce(sum(extract(epoch from (r.end_time - r.start_time)) / 60) filter (where r.status <> 'cancelled'), 0)::int as booked_minutes
         from meeting_rooms mr
         left join reservations r on r.meeting_room_id = mr.id and r.reserved_date between $1 and $2
        group by mr.id, mr.name order by mr.id`,
      [start, end],
    );
    const available = days * 14 * 60; // 하루 08:00~22:00
    return {
      month: mo,
      available_minutes: available,
      rooms: rows.map((r: any) => ({ ...r, rate: Math.round((r.booked_minutes / available) * 1000) / 10 })),
    };
  }

  // ───────── 고정석 ─────────
  @Get('seats')
  seats() {
    const today = nowKST().date;
    return query(
      `select s.id, s.seat_no, sa.id as assignment_id, mb.name as member_name, sa.start_date, sa.end_date
         from seats s
         left join seat_assignments sa on sa.seat_id = s.id and sa.start_date <= $1 and (sa.end_date is null or sa.end_date >= $1)
         left join members mb on mb.id = sa.member_id
        order by s.seat_no`,
      [today],
    );
  }

  // 같은 자리에 기간이 겹치는 배정은 DB가 거절한다. (결정 21)
  @Post('seats/:id/assign')
  async assignSeat(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { member_id?: number; start_date?: string; end_date?: string | null },
  ) {
    const memberId = Number(body.member_id);
    if (!memberId) throw new BadRequestException('멤버를 골라 주세요.');
    if (!isYMD(body.start_date)) throw new BadRequestException('시작일을 확인해 주세요.');
    const end = body.end_date ? (isYMD(body.end_date) ? body.end_date : null) : null;
    if (body.end_date && !end) throw new BadRequestException('종료일을 확인해 주세요.');
    const [row] = await query(
      'insert into seat_assignments (seat_id, member_id, start_date, end_date) values ($1,$2,$3,$4) returning *',
      [id, memberId, body.start_date, end],
    );
    return row;
  }

  // ───────── 직원 계정 관리 (관리자만) ─────────
  @Roles('admin')
  @Get('staff')
  staffList() {
    return query(
      `select id, email, name, role, is_active, must_change_password, created_at
         from users where role in ('staff','admin') order by id`,
    );
  }

  @Roles('admin')
  @Post('staff')
  async createStaff(@Body() body: { email?: string; name?: string; role?: string }) {
    const email = String(body.email ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('이메일 형식을 확인해 주세요.');
    if (!name) throw new BadRequestException('이름을 적어 주세요.');
    const role = body.role === 'admin' ? 'admin' : 'staff';
    const temp = tempPassword();
    const [u] = await query(
      `insert into users (email, password_hash, name, role, must_change_password) values ($1,$2,$3,$4,true)
       returning id, email, name, role, is_active`,
      [email, await bcrypt.hash(temp, 10), name, role],
    );
    return { user: u, temp_password: temp, message: '임시 비밀번호는 지금만 보여요. 직원에게 전달해 주세요.' };
  }

  @Roles('admin')
  @Patch('staff/:id')
  async updateStaff(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; role?: string; is_active?: boolean },
  ) {
    const [u] = await query(`select * from users where id = $1 and role in ('staff','admin')`, [id]);
    if (!u) throw new NotFoundException('없는 직원이에요.');
    const name = body.name !== undefined ? String(body.name).trim() : u.name;
    const role = body.role === undefined ? u.role : body.role === 'admin' ? 'admin' : 'staff';
    const active = body.is_active === undefined ? u.is_active : !!body.is_active;
    if (!name) throw new BadRequestException('이름을 적어 주세요.');
    if (id === me.id && (!active || role !== u.role)) {
      throw new BadRequestException('본인 계정의 역할을 바꾸거나 사용을 중지할 수는 없어요.');
    }
    const [row] = await query(
      `update users set name = $2, role = $3, is_active = $4 where id = $1 returning id, email, name, role, is_active`,
      [id, name, role, active],
    );
    return row;
  }

  // 비밀번호 리셋: 임시 비밀번호가 나오고, 직원은 다음 로그인 때 새 비밀번호로 바꿔야 한다.
  @Roles('admin')
  @Post('staff/:id/reset-password')
  async resetPassword(@Param('id', ParseIntPipe) id: number) {
    const temp = tempPassword();
    const [u] = await query(
      `update users set password_hash = $2, must_change_password = true
        where id = $1 and role in ('staff','admin') returning id, email, name`,
      [id, await bcrypt.hash(temp, 10)],
    );
    if (!u) throw new NotFoundException('없는 직원이에요.');
    return { user: u, temp_password: temp, message: '임시 비밀번호는 지금만 보여요. 직원은 다음 로그인 때 바꿔야 해요.' };
  }

  // 관리자 화면용: 지금 쓸 수 있는 시간(고객 대리 조회)
  @Get('customers/:id/wallets')
  customerWallets(@Param('id', ParseIntPipe) id: number) {
    return getWallets(id, nowKST().date);
  }
}
