// 발표·확인용 가상 데이터. 실제 사람·회사가 아니다.
// 사용: node --env-file=.env db/demo_data.mjs   (되돌리기: psql "$DATABASE_URL" -f db/demo_data_cleanup.sql)
// 모든 가상 계정은 이메일이 @demo.corner.test 로 끝나고, 회사 이름 끝에 (가상)이 붙는다.
import pg from 'pg';
import bcrypt from 'bcryptjs';

pg.types.setTypeParser(1082, (v) => v);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  options: '-c search_path=hw2,public',
  max: 1,
});
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

const exist = await q(`select 1 from users where email like '%@demo.corner.test' limit 1`);
if (exist.length) {
  console.log('가상 데이터가 이미 있어요. 다시 넣으려면 db/demo_data_cleanup.sql 을 먼저 실행하세요.');
  await pool.end();
  process.exit(0);
}

const PW = await bcrypt.hash('corner-demo-1234', 10);
const plan = Object.fromEntries((await q('select id, name from plans')).map((r) => [r.name, r.id]));
const [admin] = await q(`select id from users where role = 'admin' order by id limit 1`);

const user = {};
const member = {};
const mship = {};

async function addUser(key, email, name, memberKey, joined, left = null) {
  const [u] = await q(
    `insert into users (email, password_hash, name, role) values ($1,$2,$3,'customer') returning id`,
    [`${email}@demo.corner.test`, PW, name],
  );
  user[key] = u.id;
  return u.id;
}
async function addMember(key, type, name) {
  const [m] = await q('insert into members (type, name) values ($1,$2) returning id', [type, name]);
  member[key] = m.id;
}
async function affil(userKey, memberKey, start, end = null) {
  await q('insert into member_users (user_id, member_id, start_date, end_date) values ($1,$2,$3,$4)', [
    user[userKey], member[memberKey], start, end,
  ]);
}
async function addMship(key, memberKey, planName, start, end) {
  const [r] = await q(
    'insert into memberships (member_id, plan_id, start_date, end_date) values ($1,$2,$3,$4) returning id',
    [member[memberKey], plan[planName], start, end],
  );
  mship[key] = r.id;
}

// ── 사람 ──
await addUser('c1', 'minsu.kim', '김민수');
await addUser('c2', 'seoyeon.lee', '이서연');
await addUser('c3', 'doyun.park', '박도윤');
await addUser('c4', 'haeun.choi', '최하은');
await addUser('c5', 'woojin.jung', '정우진');
await addUser('c6', 'jihu.han', '한지후');
await addUser('c7', 'seoa.yoon', '윤서아');
await addUser('c8', 'hajun.kang', '강하준');

// ── 멤버(개인, 회사) ──
for (const [k, n] of [['c1', '김민수'], ['c2', '이서연'], ['c3', '박도윤'], ['c4', '최하은'], ['c8', '강하준']]) {
  await addMember('i_' + k, 'individual', n);
}
await addMember('hanbit', 'company', '한빛디자인(가상)');
await addMember('lab', 'company', '모퉁이랩(가상)');

// ── 소속 (최하은은 개인 → 회사로 11/03에 옮김, 개인 남은 시간은 계속 쓴다) ──
await affil('c1', 'i_c1', '2026-10-12');
await affil('c2', 'i_c2', '2026-10-20');
await affil('c3', 'i_c3', '2026-11-01');
await affil('c4', 'i_c4', '2026-10-25', '2026-11-02');
await affil('c4', 'hanbit', '2026-11-03');
await affil('c5', 'hanbit', '2026-10-05');
await affil('c6', 'lab', '2026-10-28');
await affil('c7', 'lab', '2026-10-28');
await affil('c8', 'i_c8', '2026-10-08');

// ── 멤버십 (한 주기 = 한 줄. 이어서 갱신하면 줄이 늘어난다) ──
await addMship('c1', 'i_c1', '자유석', '2026-10-12', '2026-11-11');
await addMship('c2', 'i_c2', '고정석', '2026-10-20', '2026-11-19');
await addMship('c3', 'i_c3', '자유석', '2026-11-01', '2026-11-30');
await addMship('c4', 'i_c4', '자유석', '2026-10-25', '2026-11-24');
await addMship('hb1', 'hanbit', '오피스', '2026-10-05', '2026-11-04');
await addMship('hb2', 'hanbit', '오피스', '2026-11-05', '2026-12-04');
await addMship('lab', 'lab', '고정석', '2026-10-28', '2026-11-27');
await addMship('c8', 'i_c8', '자유석', '2026-10-08', '2026-11-07');

// ── 고정석 배정 ──
const seat = Object.fromEntries((await q('select id, seat_no from seats')).map((r) => [r.seat_no, r.id]));
await q('insert into seat_assignments (seat_id, member_id, start_date, end_date) values ($1,$2,$3,$4)', [seat['101'], member.i_c2, '2026-10-20', null]);
await q('insert into seat_assignments (seat_id, member_id, start_date, end_date) values ($1,$2,$3,$4)', [seat['102'], member.lab, '2026-10-28', '2026-11-27']);

// ── 예약 ──
let n = 0;
async function res(userKey, room, date, start, end, people, status, charges, opts = {}) {
  const [r] = await q(
    `insert into reservations (meeting_room_id, user_id, reserved_date, start_time, end_time, people_count, status,
                               checked_in_at, cancelled_at, corrected_by, correction_reason)
     values ($1,$2,$3,$4,$5,$6,$7,
             case when $7 = 'completed' then ($3::date + $4::time) at time zone 'Asia/Seoul' end,
             case when $9::time is not null then ($3::date + $9::time) at time zone 'Asia/Seoul' end,
             $10, $8)
     returning id`,
    [room, user[userKey], date, start, end, people, status, opts.reason ?? null, opts.cancelledAt ?? null, opts.correctedBy ?? null],
  );
  for (const [mk, minutes] of charges) {
    await q('insert into usage_records (reservation_id, membership_id, minutes) values ($1,$2,$3)', [r.id, mship[mk], minutes]);
  }
  n += 1;
}

// 김민수 (자유석, 한도 4시간)
await res('c1', 4, '2026-10-20', '15:00', '16:00', 3, 'completed', [['c1', 60]]);
await res('c1', 1, '2026-11-04', '11:00', '12:00', 2, 'completed', [['c1', 60]]);
await res('c1', 2, '2026-11-05', '09:00', '10:00', 4, 'completed', [['c1', 60]]);
await res('c1', 3, '2026-11-09', '10:00', '11:00', 3, 'reserved', [['c1', 60]]);
// 이서연 (고정석, 한도 10시간) — 늦은 취소 1회(첫 번째라서 0%)
await res('c2', 4, '2026-10-28', '13:00', '15:00', 8, 'completed', [['c2', 120]]);
await res('c2', 2, '2026-11-01', '10:00', '11:00', 5, 'completed', [['c2', 60]]);
await res('c2', 1, '2026-11-03', '17:00', '17:30', 2, 'cancelled', [['c2', 0]], { cancelledAt: '16:30' });
await res('c2', 4, '2026-11-07', '14:00', '16:00', 9, 'reserved', [['c2', 120]]);
// 박도윤 (자유석, 한도 4시간) — 노쇼 2회(0%, 50%)와 한도 초과
await res('c3', 3, '2026-11-02', '10:00', '12:00', 6, 'completed', [['c3', 120]]);
await res('c3', 2, '2026-11-03', '14:00', '15:30', 4, 'completed', [['c3', 90]]);
await res('c3', 1, '2026-11-04', '09:00', '10:00', 2, 'no_show', [['c3', 0]]);
await res('c3', 4, '2026-11-05', '14:00', '15:00', 3, 'no_show', [['c3', 30]]);
await res('c3', 3, '2026-11-06', '16:00', '18:00', 6, 'reserved', [['c3', 120]]);
// 최하은 (개인 시간을 먼저 쓰고 모자라면 회사 시간)
await res('c4', 1, '2026-10-28', '13:00', '14:00', 3, 'completed', [['c4', 60]]);
await res('c4', 2, '2026-11-04', '13:00', '15:00', 5, 'completed', [['c4', 120]]);
await res('c4', 2, '2026-11-06', '09:00', '11:00', 5, 'reserved', [['c4', 60], ['hb2', 60]]);
// 정우진 (한빛디자인)
await res('c5', 4, '2026-10-15', '14:00', '17:00', 10, 'completed', [['hb1', 180]]);
await res('c5', 3, '2026-10-22', '10:00', '12:00', 6, 'completed', [['hb1', 120]]);
await res('c5', 1, '2026-11-02', '15:00', '16:00', 2, 'cancelled', [], { cancelledAt: '09:00' });
await res('c5', 3, '2026-11-05', '11:00', '12:30', 6, 'completed', [['hb2', 90]]);
await res('c5', 4, '2026-11-06', '10:00', '12:00', 8, 'reserved', [['hb2', 120]]);
// 한지후, 윤서아 (모퉁이랩)
await res('c6', 2, '2026-10-30', '09:00', '11:00', 5, 'completed', [['lab', 120]]);
await res('c6', 3, '2026-11-04', '14:00', '16:00', 7, 'completed', [['lab', 120]]);
await res('c6', 3, '2026-11-06', '13:00', '15:00', 7, 'reserved', [['lab', 120]]);
await res('c7', 4, '2026-11-03', '10:00', '11:30', 8, 'completed', [['lab', 90]]);
await res('c7', 2, '2026-11-04', '11:00', '12:00', 4, 'cancelled', [], { cancelledAt: '11:20', correctedBy: admin.id, reason: '지하철 지연으로 늦음, 직원이 정정' });
await res('c7', 2, '2026-11-06', '14:00', '16:00', 5, 'reserved', [['lab', 120]]);
await res('c7', 4, '2026-11-08', '10:00', '12:00', 9, 'reserved', [['lab', 120]]);
// 강하준 (자유석, 곧 종료)
await res('c8', 1, '2026-10-20', '10:00', '12:00', 3, 'completed', [['c8', 120]]);
await res('c8', 4, '2026-11-05', '16:00', '17:00', 3, 'completed', [['c8', 60]]);

const counts = await q(`select (select count(*) from users) u, (select count(*) from members) m, (select count(*) from memberships) ms,
  (select count(*) from reservations) r, (select count(*) from usage_records) ur, (select count(*) from seat_assignments) sa`);
console.log('가상 데이터를 넣었어요. 예약', n, '건 추가.', JSON.stringify(counts[0]));
await pool.end();
