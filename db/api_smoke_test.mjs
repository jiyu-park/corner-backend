const B = 'http://localhost:4000';
const run = Date.now().toString(36);
let fails = 0;

async function call(method, path, token, body) {
  const res = await fetch(B + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function expect(label, r, status, extra) {
  const ok = (r.status === status || ([200, 201].includes(status) && [200, 201].includes(r.status))) && (!extra || extra(r.json));
  if (!ok) fails++;
  const msg = r.json.message ?? (Array.isArray(r.json) ? `(${r.json.length}건)` : '');
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} → ${r.status}${r.json.source ? ' [' + r.json.source + (r.json.db_constraint ? ':' + r.json.db_constraint : '') + ']' : ''} ${typeof msg === 'string' ? msg : ''}`);
  return r.json;
}
const tomorrow = new Date(Date.now() + 9 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const dayAfter = new Date(Date.now() + 9 * 3600e3 + 2 * 86400e3).toISOString().slice(0, 10);
const farFuture = new Date(Date.now() + 9 * 3600e3 + 90 * 86400e3).toISOString().slice(0, 10);

// ── 가입·로그인 ──
const a = expect('회원가입 alice', await call('POST', '/auth/signup', null, { email: `smoke-a-${run}@test.com`, password: 'password1', name: '스모크A' }), 201);
const A = a.token;
const b = expect('회원가입 bob', await call('POST', '/auth/signup', null, { email: `smoke-b-${run}@test.com`, password: 'password1', name: '스모크B' }), 201);
const Bt = b.token;
expect('이메일 중복(대소문자 달라도) → DB', await call('POST', '/auth/signup', null, { email: `SMOKE-A-${run}@test.com`, password: 'password1', name: 'x' }), 409, (j) => j.source === 'db');
expect('비밀번호 8자 미만', await call('POST', '/auth/signup', null, { email: `smoke-c-${run}@test.com`, password: 'short', name: 'x' }), 400);
expect('틀린 비밀번호', await call('POST', '/auth/login', null, { email: `smoke-a-${run}@test.com`, password: 'wrongwrong', app: 'web' }), 401);
expect('고객이 어드민 로그인', await call('POST', '/auth/login', null, { email: `smoke-a-${run}@test.com`, password: 'password1', app: 'admin' }), 403);
expect('로그인 없이 /me', await call('GET', '/me'), 401);
expect('고객이 어드민 API', await call('GET', '/admin/members', A), 403);

// ── 예약 규칙 ──
const rooms = (await call('GET', '/meeting-rooms', A)).json;
const roomB = rooms.find((r) => r.max_people === 6);
console.log('   회의실:', rooms.map((r) => `${r.name}(${r.max_people}명)`).join(', '));
expect('멤버십 없이 예약 → 백엔드', await call('POST', '/reservations', A, { meeting_room_id: roomB.id, reserved_date: tomorrow, start_time: '14:00', end_time: '16:00', people_count: 4 }), 400, (j) => j.source === 'backend');
expect('자유석 신청(A)', await call('POST', '/me/membership', A, { plan_id: (await call('GET', '/plans', A)).json[0].id }), 201);
expect('자유석 신청(B)', await call('POST', '/me/membership', Bt, { plan_id: (await call('GET', '/plans', A)).json[0].id }), 201);
expect('정원 초과(6인실 20명) → 백엔드', await call('POST', '/reservations', A, { meeting_room_id: roomB.id, reserved_date: tomorrow, start_time: '14:00', end_time: '16:00', people_count: 20 }), 400, (j) => j.source === 'backend');
expect('멤버십 기간 밖 날짜 → 백엔드', await call('POST', '/reservations', A, { meeting_room_id: roomB.id, reserved_date: farFuture, start_time: '14:00', end_time: '16:00', people_count: 4 }), 400, (j) => j.source === 'backend');
const r1 = expect('정상 예약 2시간', await call('POST', '/reservations', A, { meeting_room_id: roomB.id, reserved_date: tomorrow, start_time: '14:00', end_time: '16:00', people_count: 4 }), 201);
expect('같은 시간 겹침(다른 사람) → DB', await call('POST', '/reservations', Bt, { meeting_room_id: roomB.id, reserved_date: tomorrow, start_time: '15:00', end_time: '17:00', people_count: 2 }), 409, (j) => j.source === 'db');
expect('22시 이후 → DB', await call('POST', '/reservations', Bt, { meeting_room_id: roomB.id, reserved_date: tomorrow, start_time: '21:00', end_time: '23:00', people_count: 2 }), 400, (j) => j.source === 'db');
expect('30분 단위 아님 → DB', await call('POST', '/reservations', Bt, { meeting_room_id: roomB.id, reserved_date: tomorrow, start_time: '10:10', end_time: '11:00', people_count: 2 }), 400, (j) => j.source === 'db');
expect('끝 < 시작 → DB', await call('POST', '/reservations', Bt, { meeting_room_id: roomB.id, reserved_date: tomorrow, start_time: '12:00', end_time: '11:00', people_count: 2 }), 400, (j) => j.source === 'db');
expect('인원 수정 정원 초과 → 백엔드', await call('PATCH', `/reservations/${r1.reservation.id}`, A, { people_count: 9 }), 400, (j) => j.source === 'backend');
expect('인원 수정 정상', await call('PATCH', `/reservations/${r1.reservation.id}`, A, { people_count: 5 }), 200);

// ── 초과 과금(한도 4시간, 이미 2시간 사용) ──
const r2 = expect('3시간 추가 예약 → 1시간 초과', await call('POST', '/reservations', A, { meeting_room_id: rooms[3].id, reserved_date: tomorrow, start_time: '09:00', end_time: '12:00', people_count: 5 }), 201, (j) => j.overage_minutes === 60);
const me = (await call('GET', '/me', A)).json;
console.log('   내 지갑:', me.wallets.map((w) => `${w.member_name} ${w.plan_name} 총${w.total_minutes}분/사용${w.used_minutes}분/남음${w.remaining_minutes}분`).join(' | '));
expect('정상 취소(1시간 이상 전) → 전액 반환', await call('POST', `/reservations/${r2.reservation.id}/cancel`, A), 200, (j) => j.late === false);
const meAfter = (await call('GET', '/me', A)).json;
console.log('   취소 후 남음:', meAfter.wallets[0].remaining_minutes, '분');

// ── 늦은 취소 / 노쇼 / 정정 ──
const nowKst = new Date(Date.now() + 9 * 3600e3);
const hh = String(nowKst.getUTCHours()).padStart(2, '0');
const hhNext = String(Math.min(22, nowKst.getUTCHours() + 1)).padStart(2, '0');
const startNext = `${String(Math.min(21, nowKst.getUTCHours() + 1)).padStart(2, '0')}:${nowKst.getUTCMinutes() < 30 ? '00' : '30'}`;
console.log('   (현재 KST', `${hh}:${String(nowKst.getUTCMinutes()).padStart(2, '0')})`);
// 늦은 취소: 오늘 지금부터 1시간 안에 시작하는 예약이 필요. 시간대가 맞지 않으면 건너뛴다.
const today = nowKst.toISOString().slice(0, 10);
const nowMin = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
let lateStart = Math.ceil((nowMin + 5) / 30) * 30; // 가장 가까운 다음 30분
if (lateStart - nowMin >= 60) lateStart -= 30;
if (lateStart >= 8 * 60 && lateStart + 30 <= 22 * 60 && lateStart - nowMin < 60) {
  const t = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const l1 = expect('오늘 곧 시작하는 예약', await call('POST', '/reservations', A, { meeting_room_id: rooms[0].id, reserved_date: today, start_time: t(lateStart), end_time: t(lateStart + 30), people_count: 2 }), 201);
  expect('늦은 취소 1회차 → 0%', await call('POST', `/reservations/${l1.reservation.id}/cancel`, A), 200, (j) => j.late === true && j.percent === 0);
} else {
  console.log('SKIP 늦은 취소(현재 시각이 운영 시간 밖)');
}
const dayRes = expect('예약(노쇼용)', await call('POST', '/reservations', A, { meeting_room_id: rooms[2].id, reserved_date: dayAfter, start_time: '10:00', end_time: '11:00', people_count: 3 }), 201);

// ── 직원 계정 ──
const adm = expect('관리자 로그인', await call('POST', '/auth/login', null, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, app: 'admin' }), 200);
const AD = adm.token;
expect('관리자가 웹 로그인', await call('POST', '/auth/login', null, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, app: 'web' }), 403);
const st = expect('직원 계정 생성', await call('POST', '/admin/staff', AD, { email: `smoke-staff-${run}@test.com`, name: '스모크직원', role: 'staff' }), 201);
const ST = expect('직원 임시 비밀번호 로그인', await call('POST', '/auth/login', null, { email: `smoke-staff-${run}@test.com`, password: st.temp_password, app: 'admin' }), 200, (j) => j.user.must_change_password === true).token;
expect('임시 비밀번호 상태에서 다른 기능 → 막힘', await call('GET', '/admin/reservations', ST), 403, (j) => j.code === 'MUST_CHANGE_PASSWORD');
expect('비밀번호 변경', await call('POST', '/auth/change-password', ST, { old_password: st.temp_password, new_password: 'newpassword1' }), 201);
expect('직원이 예약 현황 조회', await call('GET', `/admin/reservations?date=${dayAfter}`, ST), 200);
expect('일반 직원이 직원 관리 → 막힘', await call('GET', '/admin/staff', ST), 403);
const rs = expect('관리자가 비밀번호 리셋', await call('POST', `/admin/staff/${st.user.id}/reset-password`, AD), 201);
expect('리셋 후 다시 임시 상태', await call('POST', '/auth/login', null, { email: `smoke-staff-${run}@test.com`, password: rs.temp_password, app: 'admin' }), 200, (j) => j.user.must_change_password === true);
expect('직원 사용 중지', await call('PATCH', `/admin/staff/${st.user.id}`, AD, { is_active: false }), 200);
expect('사용 중지된 직원 로그인 → 막힘', await call('POST', '/auth/login', null, { email: `smoke-staff-${run}@test.com`, password: rs.temp_password, app: 'admin' }), 403);

// ── 노쇼 전환(D2), 정정 ──
const ns = expect('노쇼 전환(시연: 시작 20분 뒤라고 가정)', await call('POST', '/admin/reservations/mark-no-shows', AD, { as_of: `${dayAfter}T10:20:00+09:00` }), 201, (j) => j.changed >= 1);
const mine = (await call('GET', '/reservations/mine', A)).json;
console.log('   노쇼 결과:', JSON.stringify(ns.reservations.filter((x) => x.id === dayRes.reservation.id)));
console.log('   예약 상태:', mine.map((m) => `${m.reserved_date} ${m.start_time} ${m.status}(차감${m.charged_minutes}분)`).join(' | '));
expect('노쇼 정정(사유 없음) → 거절', await call('POST', `/admin/reservations/${dayRes.reservation.id}/correct`, AD, { reason: '' }), 400);
expect('노쇼 정정', await call('POST', `/admin/reservations/${dayRes.reservation.id}/correct`, AD, { reason: '교통 사고로 늦음' }), 201);

// ── 개인 → 회사 이동(D3 준비), 개인 시간부터 차감 ──
const co = expect('회사 멤버 생성', await call('POST', '/admin/members', AD, { name: `스모크회사${run}` }), 201);
expect('회사 오피스 멤버십', await call('POST', `/admin/members/${co.id}/membership`, AD, { plan_id: (await call('GET', '/plans', A)).json[2].id }), 201);
const custs = (await call('GET', '/admin/customers', AD)).json;
const aliceId = custs.find((c) => c.email === `smoke-a-${run}@test.com`).id;
const mu = expect('alice를 회사에 소속', await call('POST', `/admin/members/${co.id}/users`, AD, { user_id: aliceId }), 201);
const me2 = (await call('GET', '/me', A)).json;
console.log('   소속 후 지갑:', me2.wallets.map((w) => `${w.member_type}:${w.member_name} 남음${w.remaining_minutes}분`).join(' | '));
// 개인 남은 시간(한도4h-사용2h=...)을 넘기는 예약: 개인에서 먼저 쓰고 나머지는 회사에서
const split = expect('분할 차감 예약(개인 먼저)', await call('POST', '/reservations', A, { meeting_room_id: rooms[3].id, reserved_date: tomorrow, start_time: '13:00', end_time: '17:00', people_count: 6 }), 201);
console.log('   차감 내역:', split.charged.map((p) => `${p.member_name} ${p.minutes}분`).join(', '), '| 초과', split.overage_minutes, '분');
const bill = expect('청구 금액 조회(회사)', await call('GET', `/admin/billing?member_id=${co.id}`, AD), 200);
console.log('   청구:', JSON.stringify(bill));
const lv = expect('퇴사 처리 → 앞으로 예약 자동 취소', await call('POST', `/admin/member-users/${mu.id}/leave`, AD, {}), 201, (j) => j.cancelled_reservations >= 1);
console.log('   ', lv.message);

// ── 고정석, 직원 종료 예정/이용률 ──
const seats = (await call('GET', '/admin/seats', AD)).json;
const bobMember = (await call('GET', '/admin/members', AD)).json.find((m) => m.name === '스모크B');
expect('자리 배정', await call('POST', `/admin/seats/${seats[0].id}/assign`, AD, { member_id: bobMember.id, start_date: '2026-11-01', end_date: '2026-12-31' }), 201);
expect('겹치는 기간 자리 배정 → DB', await call('POST', `/admin/seats/${seats[0].id}/assign`, AD, { member_id: co.id, start_date: '2026-12-15', end_date: null }), 409, (j) => j.source === 'db');
expect('이번 달 종료 멤버', await call('GET', '/admin/memberships/ending', AD), 200);
expect('회의실 이용률', await call('GET', '/admin/rooms/utilization', AD), 200);

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
