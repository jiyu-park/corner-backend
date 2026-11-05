// 처음 관리자 계정 하나를 만든다. (이미 있으면 아무것도 하지 않는다)
// 사용: npm run build && npm run seed:admin
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { pool, query } from '../db';

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('ADMIN_EMAIL, ADMIN_PASSWORD를 .env에 적어 주세요.');
  const exist = await query('select id from users where lower(email) = lower($1)', [email]);
  if (exist.length) {
    console.log('관리자 계정이 이미 있어요.');
  } else {
    await query(`insert into users (email, password_hash, name, role) values ($1,$2,'관리자','admin')`, [
      email,
      await bcrypt.hash(password, 10),
    ]);
    console.log(`관리자 계정을 만들었어요: ${email}`);
  }
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
