import 'dotenv/config';
import { types, Pool, PoolClient } from 'pg';

// date, time을 JS Date로 바꾸지 않고 문자열 그대로 받는다.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1083, (v) => v);

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL이 없습니다. .env를 확인해 주세요.');

export const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  max: 5,
  // 모든 연결은 hw2 스키마를 우선 사용한다. (1주차 테이블과 섞이지 않게)
  options: '-c search_path=hw2,public',
});

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function q<T = any>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await c.query(sql, params);
  return res.rows as T[];
}
