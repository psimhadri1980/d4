import { Module } from '@nestjs/common';
import { AdminWebModulesController, WebModulesController } from './web-modules.controller';

/** The web module registry (D64): what the shell loads at run time. */
@Module({ controllers: [WebModulesController, AdminWebModulesController] })
export class WebModulesModule {}
