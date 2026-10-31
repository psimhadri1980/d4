import type { Provider } from '@nestjs/common';
import {
  BackupStore,
  ConnectorStore,
  JobStore,
  MetamodelStore,
  ProposalStore,
  QueryCatalogStore,
  RoleStore,
  ScheduleStore,
  TenantStore,
  UsageStore,
  UserStore,
  WebhookStore,
  WebModuleStore,
  WorkspaceStore,
  type DbOrTx,
} from '@d4/db';
import { Database } from './database.service';

/**
 * The control-plane stores as singletons on the shared pool; inject them by class. Code that
 * needs a store inside a transaction still constructs one on the transaction.
 */
const STORES: (new (db: DbOrTx) => object)[] = [
  BackupStore,
  ConnectorStore,
  JobStore,
  MetamodelStore,
  ProposalStore,
  QueryCatalogStore,
  RoleStore,
  ScheduleStore,
  TenantStore,
  UsageStore,
  UserStore,
  WebhookStore,
  WebModuleStore,
  WorkspaceStore,
];

export const storeProviders: Provider[] = STORES.map((Store) => ({ provide: Store, useFactory: (d: Database) => new Store(d.db), inject: [Database] }));
