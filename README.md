# corner-backend

공유 오피스 "모퉁이"의 백엔드입니다. 코어 웹(고객)과 어드민(직원)이 이 서버 하나를 함께 씁니다.

- NestJS + PostgreSQL (Render, `hw2` 스키마)
- 설계 기록: 프로젝트 루트의 `DESIGN_LOG.md`

## 실행

```bash
cp .env.example .env     # 값을 채운다 (아래 설정값 참고)
npm install
npm run db:schema        # hw2 스키마와 테이블 만들기 (psql 필요)
npm run db:seed          # 가상 기본 데이터(멤버십 종류, 회의실, 자리)
npm run build
npm run seed:admin       # 처음 관리자 계정 1개
npm run start:dev        # http://localhost:4000
```

## 설정값 (.env, GitHub에 올리지 않습니다)

| 이름 | 설명 |
|---|---|
| `DATABASE_URL` | Render PostgreSQL의 **External** Database URL |
| `JWT_SECRET` | 로그인 토큰 서명용 긴 임의 문자열 |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | 처음 만들 관리자 계정 |
| `FRONTEND_URL` | 요청을 허용할 코어 웹·어드민 주소(쉼표로 구분) |
| `PORT` | 기본 4000 (Render는 자동으로 지정) |

## Render 배포

- Build Command: `npm install && npm run build`
- Start Command: `npm run start:prod`
- 위 설정값을 Render 환경 변수에 넣고, `FRONTEND_URL`에는 배포된 코어 웹과 어드민 주소를 쉼표로 넣습니다.
- 무료 서버는 15분 쓰지 않으면 잠들어 첫 접속이 1분 가까이 걸립니다. 발표 직전에 `/health`를 한 번 열어 깨워 둡니다.

## DB 규칙과 백엔드 규칙

한 테이블 안에서 확인되는 규칙은 DB가, 다른 테이블을 함께 봐야 하는 규칙은 백엔드가 막습니다.
오류 응답에는 누가 거절했는지 `source`(`db` 또는 `backend`)가 들어 있습니다.

| DB가 막음 (`db/schema.sql`) | 백엔드가 막음 |
|---|---|
| 이메일 중복, 허용 값(역할·상태) | 정원 초과(예약·인원 수정) |
| 같은 회의실 같은 시간 겹침(취소 제외) | 멤버십 기간 밖 예약 |
| 끝 > 시작, 08:00~22:00, 30분 단위 | 노쇼·늦은 취소 차감, 초과 시간 과금 |
| 같은 자리 기간 겹침, 한 사람 동시 두 곳 소속, 한 멤버 동시 두 멤버십 | 퇴사·해지 시 앞으로 예약 자동 취소 |
| | 로그인·권한·임시 비밀번호·사용 중지 |

`db/rule_tests.sql`로 DB 규칙을, `db/api_smoke_test.mjs`로 API 전체 흐름을 확인할 수 있습니다.

```bash
psql "$DATABASE_URL" -f db/rule_tests.sql            # 모두 rollback, 데이터가 남지 않음
node --env-file=.env db/api_smoke_test.mjs           # 서버가 떠 있어야 함. 테스트 데이터가 남으니 아래로 정리
```

## 가상 데이터 (발표·확인용)

실제 사람과 회사가 아닌 가상 데이터입니다. 이메일이 `@demo.corner.test`로 끝나고 회사 이름에 `(가상)`이 붙습니다.

```bash
node --env-file=.env db/demo_data.mjs                 # 넣기 (사람 8명, 멤버 7개, 예약 30건)
psql "$DATABASE_URL" -f db/demo_data_cleanup.sql      # 지우기 (체험용 계정과 관리자는 그대로)
```

한도 초과 과금, 노쇼 0%·50% 차감, 직원 정정, 개인 시간을 먼저 쓰는 분할 차감, 회사 이동 사례가 들어 있습니다.

## 주요 API

| 구분 | 경로 |
|---|---|
| 인증 | `POST /auth/signup`, `POST /auth/login`(`app: web \| admin`), `POST /auth/change-password` |
| 고객 | `GET /me`, `POST /me/membership`, `POST /me/membership/change`, `GET /meeting-rooms`, `GET /meeting-rooms/:id/day`, `GET /reservations/mine`, `POST /reservations`, `PATCH /reservations/:id`, `POST /reservations/:id/cancel` |
| 직원 | `GET /admin/reservations`, `POST /admin/reservations/:id/check-in\|complete\|correct`, `POST /admin/reservations/mark-no-shows` |
| 직원(멤버) | `GET /admin/members`, `GET /admin/billing`, `POST /admin/members`, `POST /admin/members/:id/membership\|users`, `POST /admin/member-users/:id/leave`, `POST /admin/memberships/:id/terminate` |
| 직원(현황) | `GET /admin/memberships/ending`, `GET /admin/rooms/utilization`, `GET /admin/seats`, `POST /admin/seats/:id/assign` |
| 관리자 전용 | `GET/POST /admin/staff`, `PATCH /admin/staff/:id`, `POST /admin/staff/:id/reset-password` |

모든 데이터는 가상입니다. 실제 개인정보를 쓰지 않습니다.
