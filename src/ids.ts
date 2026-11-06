import { BadRequestException, NotFoundException, ParseUUIDPipe } from '@nestjs/common';
import { query } from './db';

// 밖(화면, API, 로그인 토큰)에는 연번 id 대신 public_id(무작위 UUID)만 쓴다.
// DB 안에서 표를 잇는 id(연번)는 밖으로 내보내지 않는다. (users, members, reservations)
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUUID = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** 주소에 들어온 번호가 UUID 모양인지 확인한다. */
export const uuidPipe = () =>
  new ParseUUIDPipe({ exceptionFactory: () => new BadRequestException('올바르지 않은 번호예요.') });

/** 밖에서 받은 public_id를 DB 안의 id로 바꾼다. UUID가 아니면 400, 없으면 404. */
export async function internalId(table: 'users' | 'members' | 'reservations', publicId: unknown, message: string) {
  if (!isUUID(publicId)) throw new BadRequestException(message);
  const [row] = await query(`select id from ${table} where public_id = $1`, [publicId]);
  if (!row) throw new NotFoundException(message);
  return row.id as number;
}
