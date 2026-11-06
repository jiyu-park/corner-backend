import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from './auth';
import { q, query, tx } from './db';
import { addDays, cycleFor, isHM, isYMD, minutesBetween, monthRange, nowKST } from './dates';
import {
  allocateUsage,
  anchorFor,
  applyPenalty,
  getWallets,
  previewUsage,
  releaseUsage,
  runner,
  OVERAGE_PER_HOUR,
} from './core';

const hm = (t: string) => (t.length === 5 ? `${t}:00` : t);

@Controller()
export class CustomerController {
  // ───────── 공통 조회 ─────────
  @Get('plans')
  plans() {
    return query('select id, name, monthly_fee, monthly_hours from plans order by monthly_fee');
  }

  @Get('meeting-rooms')
  rooms() {
    return query('select id, name, max_people, has_video from meeting_rooms order by id');
  }

  // 한 회의실의 하루 예약 현황 (누가 예약했는지는 보여 주지 않는다)
  @Get('meeting-rooms/:id/day')
  async roomDay(@Param('id', ParseIntPipe) id: number, @Query('date') date?: string) {
    const d = date && isYMD(date) ? date : nowKST().date;
    const rows = await query(
      `select id, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, status
         from reservations
        where meeting_room_id = $1 and reserved_date = $2 and status <> 'cancelled'
        order by start_time`,
      [id, d],
    );
    return { date: d, reservations: rows };
  }

  // ───────── 내 정보 ─────────
  @Roles('customer')
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const today = nowKST().date;
    const R = runner();
    const [member] = await R(
      `select mb.id, mb.type, mb.name, mu.start_date as joined_on
         from member_users mu join members mb on mb.id = mu.member_id
        where mu.user_id = $1 and mu.start_date <= $2 and (mu.end_date is null or mu.end_date >= $2)`,
      [user.id, today],
    );
    const wallets = await getWallets(user.id, today);
    const memberships = member
      ? await R(
          `select m.id, p.name as plan_name, p.monthly_hours, m.start_date, m.end_date
             from memberships m join plans p on p.id = m.plan_id
            where m.member_id = $1 order by m.start_date`,
          [member.id],
        )
      : [];
    const [v] = await R(
      `select count(*)::int as n from reservations r
        where r.user_id = $1 and r.corrected_by is null
          and (r.status = 'no_show'
               or (r.status = 'cancelled'
                   and (r.cancelled_at at time zone 'Asia/Seoul') > (r.reserved_date + r.start_time) - interval '1 hour'))`,
      [user.id],
    );
    return {
      user,
      member: member ?? null,
      wallets,
      memberships,
      today, // 한국 기준 오늘 날짜
      free_pass_used: v.n > 0, // 첫 노쇼·늦은 취소 면제를 이미 썼는지 (계산한 값)
      overage_per_hour: OVERAGE_PER_HOUR,
    };
  }

  // ───────── 멤버십 신청·변경 (개인 멤버) ─────────
  private async myIndividualMember(user: AuthUser, today: string) {
    const [m] = await query(
      `select mb.id, mb.type from member_users mu join members mb on mb.id = mu.member_id
        where mu.user_id = $1 and mu.start_date <= $2 and (mu.end_date is null or mu.end_date >= $2)`,
      [user.id, today],
    );
    if (!m) throw new BadRequestException('소속된 멤버가 없어요.');
    if (m.type === 'company') {
      throw new ForbiddenException('회사 멤버십은 회사 담당자(관리자)가 관리해요.');
    }
    return m.id as number;
  }

  @Roles('customer')
  @Post('me/membership')
  async startMembership(@CurrentUser() user: AuthUser, @Body() body: { plan_id?: number }) {
    const today = nowKST().date;
    const memberId = await this.myIndividualMember(user, today);
    const planId = Number(body.plan_id);
    if (!planId) throw new BadRequestException('멤버십 종류를 골라 주세요.');
    const R = runner();
    const [latest] = await R('select end_date from memberships where member_id = $1 order by end_date desc limit 1', [
      memberId,
    ]);
    if (latest && latest.end_date >= today) {
      throw new BadRequestException('이미 이용 중인 멤버십이 있어요. 종류를 바꾸려면 "멤버십 변경"을 이용해 주세요.');
    }
    const start = today;
    const end = cycleFor(start, start).end;
    const [row] = await R(
      'insert into memberships (member_id, plan_id, start_date, end_date) values ($1,$2,$3,$4) returning *',
      [memberId, planId, start, end],
    );
    return { membership: row, message: `${start}부터 ${end}까지 이용할 수 있어요.` };
  }

  // 올리면 바로 적용, 내리면 이번 주기가 끝난 다음 날부터 적용 (결정 15)
  @Roles('customer')
  @Post('me/membership/change')
  async changeMembership(@CurrentUser() user: AuthUser, @Body() body: { plan_id?: number }) {
    const today = nowKST().date;
    const memberId = await this.myIndividualMember(user, today);
    const planId = Number(body.plan_id);
    if (!planId) throw new BadRequestException('멤버십 종류를 골라 주세요.');
    return tx(async (c) => {
      const [cur] = await q(
        c,
        `select m.*, p.monthly_hours from memberships m join plans p on p.id = m.plan_id
          where m.member_id = $1 and m.start_date <= $2 and m.end_date >= $2`,
        [memberId, today],
      );
      if (!cur) throw new BadRequestException('이용 중인 멤버십이 없어요. 먼저 멤버십을 신청해 주세요.');
      const [next] = await q(c, 'select id from memberships where member_id = $1 and start_date > $2', [memberId, today]);
      if (next) throw new BadRequestException('이미 다음 주기에 적용될 변경이 있어요.');
      const [plan] = await q(c, 'select * from plans where id = $1', [planId]);
      if (!plan) throw new NotFoundException('없는 멤버십 종류예요.');
      if (plan.id === cur.plan_id) throw new BadRequestException('지금 이용 중인 종류와 같아요.');

      if (plan.monthly_hours > cur.monthly_hours) {
        // 올림: 오늘부터 새 한도. 이미 쓴 시간은 그대로 차감된다.
        if (cur.start_date >= today) {
          await q(c, 'update memberships set plan_id = $2 where id = $1', [cur.id, plan.id]);
        } else {
          await q(c, 'update memberships set end_date = $2 where id = $1', [cur.id, addDays(today, -1)]);
          await q(c, 'insert into memberships (member_id, plan_id, start_date, end_date) values ($1,$2,$3,$4)', [
            memberId,
            plan.id,
            today,
            cur.end_date,
          ]);
        }
        return { applied: 'now', message: `${plan.name}으로 바로 바뀌었어요. 이미 쓴 시간은 그대로 차감돼요.` };
      }
      // 내림: 이번 주기는 기존 한도를 끝까지 쓰고, 다음 갱신일부터 적용
      const anchor = await anchorFor(runner(c), memberId, today);
      const start = addDays(cur.end_date, 1);
      const end = cycleFor(anchor, start).end;
      await q(c, 'insert into memberships (member_id, plan_id, start_date, end_date) values ($1,$2,$3,$4)', [
        memberId,
        plan.id,
        start,
        end,
      ]);
      return {
        applied: 'next_cycle',
        message: `이번 주기(${cur.end_date}까지)는 지금 한도로 이용하고, ${start}부터 ${plan.name}이 적용돼요.`,
      };
    });
  }

  // ───────── 예약 ─────────
  // 한 달 달력용: 그 달의 예약(취소 제외)을 모든 회의실에 대해 돌려준다. 누가 예약했는지는 숨기고 "내 예약"인지만 알려 준다.
  @Roles('customer')
  @Get('reservations/calendar')
  async calendar(@CurrentUser() user: AuthUser, @Query('month') month?: string) {
    const mo = month && /^\d{4}-\d{2}$/.test(month) ? month : nowKST().date.slice(0, 7);
    const { start, end } = monthRange(mo);
    const rows = await query(
      `select r.id, r.reserved_date, to_char(r.start_time,'HH24:MI') as start_time, to_char(r.end_time,'HH24:MI') as end_time,
              r.meeting_room_id, mr.name as room_name, r.status, (r.user_id = $3) as mine
         from reservations r join meeting_rooms mr on mr.id = r.meeting_room_id
        where r.reserved_date between $1 and $2 and r.status <> 'cancelled'
        order by r.reserved_date, r.start_time`,
      [start, end, user.id],
    );
    return { month: mo, today: nowKST().date, reservations: rows }; // today는 한국 기준 오늘(해외에서 접속해도 같은 기준)
  }

  // 예약 전 미리 보기: 차감 시간, 남는 시간, 한도를 넘을 때의 청구 금액. 저장하지 않는다.
  @Roles('customer')
  @Post('reservations/preview')
  async preview(
    @CurrentUser() user: AuthUser,
    @Body() body: { reserved_date?: string; start_time?: string; end_time?: string; meeting_room_id?: number; people_count?: number },
  ) {
    if (!isYMD(body.reserved_date) || !isHM(body.start_time) || !isHM(body.end_time)) {
      return { ok: false, reason: '날짜와 시각을 확인해 주세요.' };
    }
    const minutes = minutesBetween(hm(body.start_time), hm(body.end_time));
    if (minutes <= 0) return { ok: false, reason: '끝나는 시각은 시작 시각보다 늦어야 해요.' };
    let capacity_warning: string | null = null;
    if (body.meeting_room_id && body.people_count) {
      const [room] = await query('select name, max_people from meeting_rooms where id = $1', [body.meeting_room_id]);
      if (room && Number(body.people_count) > room.max_people) {
        capacity_warning = `${room.name}은(는) 최대 ${room.max_people}명까지 이용할 수 있어요.`;
      }
    }
    const p = await previewUsage(user.id, body.reserved_date, minutes);
    return { ok: true, minutes, overage_per_hour: OVERAGE_PER_HOUR, capacity_warning, ...p };
  }

  @Roles('customer')
  @Get('reservations/mine')
  async myReservations(@CurrentUser() user: AuthUser) {
    return query(
      `select r.id, r.reserved_date, to_char(r.start_time,'HH24:MI') as start_time, to_char(r.end_time,'HH24:MI') as end_time,
              r.people_count, r.status, r.checked_in_at, r.cancelled_at, r.correction_reason,
              mr.id as meeting_room_id, mr.name as room_name,
              coalesce((select sum(minutes) from usage_records where reservation_id = r.id), 0)::int as charged_minutes
         from reservations r join meeting_rooms mr on mr.id = r.meeting_room_id
        where r.user_id = $1
        order by r.reserved_date desc, r.start_time desc`,
      [user.id],
    );
  }

  @Roles('customer')
  @Post('reservations')
  async create(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      meeting_room_id?: number;
      reserved_date?: string;
      start_time?: string;
      end_time?: string;
      people_count?: number;
    },
  ) {
    const roomId = Number(body.meeting_room_id);
    const people = Number(body.people_count);
    if (!roomId) throw new BadRequestException('회의실을 골라 주세요.');
    if (!isYMD(body.reserved_date)) throw new BadRequestException('날짜를 확인해 주세요.');
    if (!isHM(body.start_time) || !isHM(body.end_time)) throw new BadRequestException('시작·끝 시각을 확인해 주세요.');
    if (!Number.isInteger(people) || people < 1) throw new BadRequestException('참석 인원은 1명 이상이어야 해요.');

    const date = body.reserved_date;
    const start = hm(body.start_time);
    const end = hm(body.end_time);

    return tx(async (c) => {
      const [room] = await q(c, 'select * from meeting_rooms where id = $1', [roomId]);
      if (!room) throw new NotFoundException('없는 회의실이에요.');

      // ── 백엔드가 막는 규칙 (다른 테이블을 함께 봐야 하는 규칙) ──
      if (people > room.max_people) {
        throw new BadRequestException(`${room.name}은(는) 최대 ${room.max_people}명까지 이용할 수 있어요.`);
      }
      if (`${date} ${start}` <= nowKST().ts) throw new BadRequestException('이미 지난 시각은 예약할 수 없어요.');
      const wallets = await getWallets(user.id, date, c);
      if (wallets.length === 0) {
        throw new BadRequestException(
          '이 날짜에는 이용할 수 있는 멤버십이 없어요. 멤버십 기간 안의 날짜로 예약하거나, 멤버십을 신청·연장해 주세요.',
        );
      }

      // ── DB가 막는 규칙 (시간 겹침, 끝>시작, 08~22시, 30분 단위)은 insert할 때 DB가 거절한다 ──
      const [r] = await q(
        c,
        `insert into reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count)
         values ($1,$2,$3,$4,$5,$6) returning id, reserved_date, start_time, end_time, people_count, status`,
        [roomId, user.id, date, start, end, people],
      );
      const alloc = await allocateUsage(c, r.id, user.id, date, minutesBetween(start, end));
      const overage = alloc.overage_minutes;
      return {
        reservation: r,
        charged: alloc.parts,
        overage_minutes: overage,
        message: overage
          ? `예약됐어요. 이번 달 한도를 ${overage}분 넘어서, 넘은 시간은 시간당 ${OVERAGE_PER_HOUR.toLocaleString('ko-KR')}원으로 청구돼요.`
          : '예약됐어요.',
      };
    });
  }

  // 참석 인원 수정: 만들 때와 같은 정원 검사를 다시 한다. (결정 16)
  @Roles('customer')
  @Patch('reservations/:id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { people_count?: number },
  ) {
    const people = Number(body.people_count);
    if (!Number.isInteger(people) || people < 1) throw new BadRequestException('참석 인원은 1명 이상이어야 해요.');
    const [r] = await query(
      `select r.*, mr.max_people, mr.name as room_name from reservations r join meeting_rooms mr on mr.id = r.meeting_room_id
        where r.id = $1 and r.user_id = $2`,
      [id, user.id],
    );
    if (!r) throw new NotFoundException('내 예약이 아니에요.');
    if (r.status !== 'reserved') throw new BadRequestException('예약 상태에서만 인원을 바꿀 수 있어요.');
    if (`${r.reserved_date} ${r.start_time}` <= nowKST().ts) throw new BadRequestException('이미 시작된 예약이에요.');
    if (people > r.max_people) {
      throw new BadRequestException(`${r.room_name}은(는) 최대 ${r.max_people}명까지 이용할 수 있어요.`);
    }
    await query('update reservations set people_count = $2 where id = $1', [id, people]);
    return { ok: true, people_count: people };
  }

  // 취소: 시작 1시간 전까지는 무료, 그 뒤는 늦은 취소(첫 번째 0%, 이후 50% 차감)
  @Roles('customer')
  @Post('reservations/:id/cancel')
  async cancel(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const now = nowKST().ts;
    return tx(async (c) => {
      const [r] = await q(
        c,
        `select r.id, r.status,
                ($2::timestamp >= (r.reserved_date + r.start_time)) as started,
                ($2::timestamp > (r.reserved_date + r.start_time) - interval '1 hour') as late
           from reservations r where r.id = $1 and r.user_id = $3 for update`,
        [id, now, user.id],
      );
      if (!r) throw new NotFoundException('내 예약이 아니에요.');
      if (r.status !== 'reserved') throw new BadRequestException('이미 처리된 예약이에요.');
      if (r.started) throw new BadRequestException('이미 시작된 예약은 취소할 수 없어요.');

      await q(c, `update reservations set status = 'cancelled', cancelled_at = now() where id = $1`, [id]);
      if (!r.late) {
        await releaseUsage(c, id);
        return { late: false, message: '취소됐어요. 차감된 시간은 모두 돌려드렸어요.' };
      }
      const p = await applyPenalty(c, id, user.id);
      return {
        late: true,
        percent: p.percent,
        message: p.first_violation
          ? '시작 1시간 이내 취소예요. 첫 번째라서 이번에는 시간을 차감하지 않아요.'
          : '시작 1시간 이내 취소예요. 예약 시간의 50%가 차감돼요.',
      };
    });
  }
}
