import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from '../config';
import { Database } from './database.service';
import { JobsInfra } from './jobs.service';
import { storeProviders } from './stores';
import { TenantGraphService } from './tenant-graph.service';

/** Settings, the Postgres pool and its stores, tenant graphs and the job queues: shared by every feature. */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }, Database, ...storeProviders, TenantGraphService, JobsInfra],
  exports: [APP_CONFIG, Database, ...storeProviders, TenantGraphService, JobsInfra],
})
export class InfraModule {}
