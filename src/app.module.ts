import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth';
import { AuthController } from './auth.controller';
import { CustomerController } from './customer.controller';
import { AdminController } from './admin.controller';

@Module({
  controllers: [AuthController, CustomerController, AdminController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
