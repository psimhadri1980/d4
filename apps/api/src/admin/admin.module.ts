import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { BackupsController } from './backups.controller';

/** Tenant administration: workspaces, people and roles, usage, backups. */
@Module({ controllers: [AdminController, BackupsController] })
export class AdminModule {}
