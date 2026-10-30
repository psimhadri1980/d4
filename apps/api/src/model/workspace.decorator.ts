import { createParamDecorator, Inject, Injectable, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import type { Principal } from '../auth/identity';
import { ModelFactory, type ModelHandles } from './model.factory';
import { WorkspaceAccess, type Access, type WorkspaceScope } from './workspace-access.service';

/** A workspace the caller may use, with its model handles (service, queries, …). */
export interface OpenWorkspace extends ModelHandles {
  scope: WorkspaceScope;
}

interface WorkspaceRequest {
  principal: Principal;
  workspaceId: string;
  access: Access;
}

@Injectable()
class OpenWorkspacePipe implements PipeTransform<WorkspaceRequest, Promise<OpenWorkspace>> {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  async transform({ principal, workspaceId, access }: WorkspaceRequest): Promise<OpenWorkspace> {
    const scope = await this.access.resolve(principal, workspaceId, access);
    return { scope, ...this.models.for(scope) };
  }
}

const WorkspaceRequestParam = createParamDecorator((access: Access, ctx: ExecutionContext): WorkspaceRequest => {
  const req = ctx.switchToHttp().getRequest<{ principal: Principal; params: Record<string, string> }>();
  return { principal: req.principal, workspaceId: req.params['ws']!, access };
});

/**
 * The route's `:ws` workspace, checked for `access` (404 when missing or another tenant's, 403
 * without the role) and opened: `@Workspace('write') { service, scope }: OpenWorkspace`.
 */
export const Workspace = (access: Access) => WorkspaceRequestParam(access, OpenWorkspacePipe);
