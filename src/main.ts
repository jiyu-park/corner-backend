import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './filters';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 코어 웹과 어드민, 두 주소에서 오는 요청만 받는다.
  const origins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: false });
  app.useGlobalFilters(new AllExceptionsFilter());
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  console.log(`corner-backend listening on ${port}`);
}
bootstrap();
