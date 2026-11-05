import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { query } from './db';

export type Role = 'customer' | 'staff' | 'admin';
export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  must_change_password: boolean;
}

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET이 없습니다. .env를 확인해 주세요.');
  return s;
};

export const signToken = (userId: number) => jwt.sign({ sub: userId }, secret(), { expiresIn: '12h' });

export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const AllowTempPassword = () => SetMetadata('allowTempPassword', true);
export const Public = () => SetMetadata('public', true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/**
 * 모든 요청에서 로그인 상태, 역할, 사용 중지 여부를 확인한다.
 * - 로그인하지 않은 사람은 @Public()이 붙은 곳 외에는 쓸 수 없다.
 * - 사용 중지된 계정은 토큰이 있어도 쓸 수 없다.
 * - 임시 비밀번호 상태에서는 비밀번호를 바꾸기 전까지 다른 기능을 쓸 수 없다.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext) {
    const handler = ctx.getHandler();
    const cls = ctx.getClass();
    if (this.reflector.getAllAndOverride<boolean>('public', [handler, cls])) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('로그인이 필요해요.');

    let userId: number;
    try {
      userId = Number((jwt.verify(token, secret()) as any).sub);
    } catch {
      throw new UnauthorizedException('로그인이 만료되었어요. 다시 로그인해 주세요.');
    }

    const rows = await query<any>(
      'select id, email, name, role, is_active, must_change_password from users where id = $1',
      [userId],
    );
    const u = rows[0];
    if (!u || !u.is_active) throw new UnauthorizedException('사용할 수 없는 계정이에요.');

    const roles = this.reflector.getAllAndOverride<Role[]>('roles', [handler, cls]);
    if (roles && !roles.includes(u.role)) throw new ForbiddenException('이 기능을 쓸 권한이 없어요.');

    const allowTemp = this.reflector.getAllAndOverride<boolean>('allowTempPassword', [handler, cls]);
    if (u.must_change_password && !allowTemp) {
      throw new ForbiddenException({
        message: '임시 비밀번호로 로그인했어요. 새 비밀번호로 바꿔 주세요.',
        code: 'MUST_CHANGE_PASSWORD',
      });
    }

    req.user = {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      must_change_password: u.must_change_password,
    } as AuthUser;
    return true;
  }
}
