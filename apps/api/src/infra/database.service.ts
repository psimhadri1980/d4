import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createDb, type Db, type DbHandle } from '@d4/db';
import { APP_CONFIG, type AppConfig } from '../config';

/** The Postgres control-plane connection pool, shared by the whole API. */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly handle: DbHandle;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.handle = createDb(config.POSTGRES_URL);
  }

  get db(): Db {
    return this.handle.db;
  }

  async ping(): Promise<void> {
    await this.handle.pool.query('SELECT 1');
  }

  async onModuleDestroy() {
    await this.handle.close();
  }
}
