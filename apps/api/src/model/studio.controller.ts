import { Controller, HttpCode, Post } from '@nestjs/common';
import { StudioSearchBody } from './model.schemas';
import { resolveView } from './view';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';
import { z } from '../http/zod';
import { ValidBody } from '../http/zod.pipe';

/** Graph Studio reads. A POST because a lens does not fit in a query string; nothing is written. */
@Controller('v1/workspaces/:ws/studio')
export class StudioController {
  @Post('search')
  @HttpCode(200)
  async search(@Workspace('read') { queries, studio, scope }: OpenWorkspace, @ValidBody(StudioSearchBody) b: z.output<typeof StudioSearchBody>) {
    const view = await resolveView(queries, scope.registry, scope.workspaceId, b);
    return studio.search(
      scope.workspaceId,
      { types: b.types, name: b.name, attributes: b.attributes, facets: b.facets, match: b.match },
      { depth: b.depth, maxNodes: b.maxNodes, view },
    );
  }
}
