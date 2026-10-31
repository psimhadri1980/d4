import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { SchedulesController } from './schedules.controller';

/** Background jobs (exports, renders, imports) and scheduled reports. */
@Module({ controllers: [JobsController, SchedulesController] })
export class JobsModule {}
