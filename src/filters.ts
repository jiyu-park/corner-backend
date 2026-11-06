import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

// DB가 거절한 규칙을 쉬운 말로 바꿔서 돌려준다. (DB가 막은 것은 source: 'db' 로 표시)
const DB_MESSAGES: Record<string, string> = {
  users_email_unique: '이미 가입된 이메일이에요.',
  reservations_no_double_booking: '그 시간에는 이미 다른 예약이 있어요.',
  reservations_check: '끝나는 시각은 시작 시각보다 늦어야 해요.',
  reservations_check1: '예약은 08:00~22:00 안에서만 할 수 있어요.',
  reservations_check2: '예약은 30분 단위로만 할 수 있어요.',
  member_users_one_place_at_a_time: '그 기간에 이 사람은 이미 다른 곳에 소속되어 있어요.',
  memberships_one_at_a_time: '그 기간에 이 멤버는 이미 다른 멤버십이 있어요.',
  seat_assignments_no_overlap: '그 기간에 이 자리는 이미 다른 멤버에게 배정되어 있어요.',
  member_users_check: '종료일은 시작일보다 빠를 수 없어요.',
  memberships_check: '종료일은 시작일보다 빠를 수 없어요.',
  seat_assignments_check: '종료일은 시작일보다 빠를 수 없어요.',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload = typeof body === 'string' ? { message: body } : (body as any);
      return res.status(status).json({ statusCode: status, source: 'backend', ...payload });
    }

    // PostgreSQL 오류 코드: 23505 유일 제약, 23P01 겹침 방지, 23514 체크 제약, 23503 외래 키,
    // 22P02 타입에 맞지 않는 값(예: 정해진 역할 이외의 값)
    const code: string | undefined = exception?.code;
    const constraint: string | undefined = exception?.constraint;
    if (code && ['23505', '23P01', '23514', '23503', '23502', '22P02'].includes(code)) {
      const status = code === '23505' || code === '23P01' ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      return res.status(status).json({
        statusCode: status,
        source: 'db',
        message:
          (constraint && DB_MESSAGES[constraint]) ||
          (code === '22P02' ? '허용되지 않은 값이에요.' : '데이터베이스 규칙에 맞지 않는 값이에요.'),
        db_constraint: constraint ?? null,
      });
    }

    console.error(exception);
    return res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, source: 'backend', message: '서버에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.' });
  }
}
