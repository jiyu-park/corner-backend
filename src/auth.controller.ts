import { BadRequestException, Body, Controller, Get, Post, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AllowTempPassword, AuthUser, CurrentUser, Public, signToken, toPublicUser } from './auth';
import { query, q, tx } from './db';
import { nowKST } from './dates';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8) {
    throw new BadRequestException('비밀번호는 8자 이상으로 적어 주세요.');
  }
  return pw;
}

@Controller()
export class AuthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }

  // 고객 회원가입 (이메일 + 비밀번호). 개인 멤버를 함께 만들고 본인을 소속시킨다.
  @Public()
  @Post('auth/signup')
  async signup(@Body() body: { email?: string; password?: string; name?: string }) {
    const email = String(body.email ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!EMAIL_RE.test(email)) throw new BadRequestException('이메일 형식을 확인해 주세요.');
    if (!name) throw new BadRequestException('이름을 적어 주세요.');
    const password = checkPassword(body.password);
    const hash = await bcrypt.hash(password, 10);
    const today = nowKST().date;

    const user = await tx(async (c) => {
      const [u] = await q(
        c,
        `insert into users (email, password_hash, name, role) values ($1,$2,$3,'customer')
         returning id, public_id, email, name, role, must_change_password`,
        [email, hash, name],
      );
      const [m] = await q(c, `insert into members (type, name) values ('individual', $1) returning id`, [name]);
      await q(c, 'insert into member_users (user_id, member_id, start_date) values ($1,$2,$3)', [u.id, m.id, today]);
      return u;
    });
    return { token: signToken(user.public_id), user: toPublicUser(user) };
  }

  // app: 'web'이면 고객만, 'admin'이면 직원·관리자만 로그인할 수 있다.
  @Public()
  @Post('auth/login')
  async login(@Body() body: { email?: string; password?: string; app?: 'web' | 'admin' }) {
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const rows = await query<any>('select * from users where lower(email) = lower($1)', [email]);
    const u = rows[0];
    // 이메일이 틀렸는지 비밀번호가 틀렸는지 알려 주지 않는다.
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      throw new UnauthorizedException('이메일 또는 비밀번호를 확인해 주세요.');
    }
    if (!u.is_active) throw new ForbiddenException('사용이 중지된 계정이에요. 관리자에게 문의해 주세요.');
    if (body.app === 'admin' && u.role === 'customer') {
      throw new ForbiddenException('직원 전용 화면이에요. 고객은 코어 웹을 이용해 주세요.');
    }
    if (body.app === 'web' && u.role !== 'customer') {
      throw new ForbiddenException('고객 전용 화면이에요. 직원은 어드민을 이용해 주세요.');
    }
    return {
      token: signToken(u.public_id),
      user: toPublicUser(u),
    };
  }

  @AllowTempPassword()
  @Post('auth/change-password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { old_password?: string; new_password?: string },
  ) {
    const newPassword = checkPassword(body.new_password);
    const [u] = await query<any>('select password_hash from users where id = $1', [user.id]);
    if (!(await bcrypt.compare(String(body.old_password ?? ''), u.password_hash))) {
      throw new BadRequestException('현재 비밀번호가 맞지 않아요.');
    }
    if (body.old_password === newPassword) throw new BadRequestException('새 비밀번호는 현재와 달라야 해요.');
    await query('update users set password_hash = $2, must_change_password = false where id = $1', [
      user.id,
      await bcrypt.hash(newPassword, 10),
    ]);
    return { ok: true };
  }
}
