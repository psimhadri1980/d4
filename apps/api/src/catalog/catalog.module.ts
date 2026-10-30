import { Module } from '@nestjs/common';
import { CatalogController, CatalogRunController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { PackInstaller } from './pack-installer.service';
import { QueryRunService } from './query-run.service';

/** The Query Catalog: authoring, review, grants and runs of curated Cypher queries. */
@Module({
  controllers: [CatalogController, CatalogRunController],
  providers: [PackInstaller, CatalogService, QueryRunService],
})
export class CatalogModule {}
