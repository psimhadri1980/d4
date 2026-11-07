import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { GraphqlService } from '../graphql/graphql.service';
import { DiffController } from './diff.controller';
import { ElementsController } from './elements.controller';
import { StudioController } from './studio.controller';
import { InsightsController } from './insights.controller';
import { ProposalsController } from './proposals.controller';
import { RelationshipsController } from './relationships.controller';
import { RoadmapController } from './roadmap.controller';
import { TabularController } from './tabular.controller';
import { TransferController } from './transfer.controller';

/** The workspace model: elements, relationships, proposals, views (roadmap, diff, matrices), import and export, GraphQL reads. */
@Module({
  // Query lenses run their catalog query (D84).
  imports: [CatalogModule],
  controllers: [ElementsController, RelationshipsController, ProposalsController, RoadmapController, DiffController, InsightsController, TransferController, TabularController, StudioController],
  providers: [GraphqlService],
})
export class ModelModule {}
