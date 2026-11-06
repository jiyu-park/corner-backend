// 날짜는 'YYYY-MM-DD' 문자열로 다룬다. (시간대 문제를 피하려고 Date는 UTC로만 계산)

const pad = (n: number) => String(n).padStart(2, '0');

export function parseYMD(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function fmt(y: number, m: number, d: number) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 형식이 맞아도 2월 30일처럼 없는 날짜는 거른다. (Date.parse는 다음 달로 넘겨서 받아 주기 때문)
export function isYMD(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseYMD(s);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isHM(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(s);
}

export function addDays(s: string, n: number) {
  const { y, m, d } = parseYMD(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * 기준일(anchor)의 "일"을 유지하며 n개월 뒤 날짜를 구한다.
 * 그 달에 그 날짜가 없으면 그 달의 마지막 날로 맞춘다. (결정 14)
 * 예: 1/31 기준 → 2/28 → 3/31 → 4/30
 */
export function addMonthsClamp(anchor: string, n: number) {
  const { y, m, d } = parseYMD(anchor);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 날짜가 속한 "한 달 주기"를 구한다. 주기는 anchor(가입일)부터 한 달씩. */
export function cycleFor(anchor: string, date: string) {
  const a = parseYMD(anchor);
  const t = parseYMD(date);
  let k = (t.y - a.y) * 12 + (t.m - a.m);
  while (addMonthsClamp(anchor, k) > date) k -= 1;
  while (addMonthsClamp(anchor, k + 1) <= date) k += 1;
  return { start: addMonthsClamp(anchor, k), end: addDays(addMonthsClamp(anchor, k + 1), -1) };
}

/** 한국 시간 기준 "지금" */
export function nowKST(asOf?: string) {
  const base = asOf && !Number.isNaN(Date.parse(asOf)) ? new Date(asOf) : new Date();
  const kst = new Date(base.getTime() + 9 * 3600 * 1000);
  const iso = kst.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), ts: iso.slice(0, 19).replace('T', ' ') };
}

export function minutesBetween(start: string, end: string) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function monthRange(month: string) {
  // 'YYYY-MM' → [첫날, 마지막날]
  const [y, m] = month.split('-').map(Number);
  return { start: fmt(y, m, 1), end: fmt(y, m, daysInMonth(y, m)), days: daysInMonth(y, m) };
}
