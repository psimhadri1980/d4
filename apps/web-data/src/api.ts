import { d4, type Schemas } from '@d4/web-platform';

export type Upload = Schemas['Upload'];
export type TableMapping = Schemas['TableMapping'];
export type Backup = Schemas['Backup'];
export type Connector = Schemas['Connector'];
export type AnalyzedTable = Awaited<ReturnType<typeof importApi.analyze>>['tables'][number];
export type TabularImportResult = Awaited<ReturnType<typeof importApi.importTabular>>;
type Mappings = { table: string; mapping: TableMapping }[];

export const importApi = {
  analyze: (ws: string, files: Upload[]) =>
    d4().post('/v1/workspaces/{ws}/import/tabular/analyze', { path: { ws }, body: { files } }),
  importTabular: (ws: string, files: Upload[], mappings: Mappings, dryRun: boolean) =>
    d4().post('/v1/workspaces/{ws}/import/tabular', {
      path: { ws },
      query: { dryRun: dryRun ? 'true' : undefined },
      body: { files, mappings },
    }),
  createJob: (ws: string, files: Upload[], mappings: Mappings, dryRun: boolean) =>
    d4().post('/v1/workspaces/{ws}/jobs/import-tabular', {
      path: { ws },
      query: { dryRun: dryRun ? 'true' : undefined },
      body: { files, mappings },
    }),
};

export const backupsApi = {
  list: (ws: string) => d4().get('/v1/workspaces/{ws}/backups', { path: { ws } }),
  backup: (ws: string) => d4().post('/v1/workspaces/{ws}/backups', { path: { ws } }),
  verify: (ws: string) => d4().post('/v1/workspaces/{ws}/backups/verify', { path: { ws } }),
  rebuild: (ws: string, confirm: string) =>
    d4().post('/v1/workspaces/{ws}/backups/rebuild', { path: { ws }, body: { confirm } }),
  restore: (ws: string, id: string, confirm: string) =>
    d4().post('/v1/workspaces/{ws}/backups/{id}/restore', { path: { ws, id }, body: { confirm } }),
};

interface ConnectorInput {
  key?: string;
  name?: string;
  kind?: string;
  config?: Record<string, unknown>;
  mapping?: unknown;
  secret?: string | null;
  conflictPolicy?: 'skip' | 'source-wins';
  cadence?: Schemas['Cadence'] | null;
  enabled?: boolean;
}

export const connectorsApi = {
  list: (ws: string) => d4().get('/v1/workspaces/{ws}/connectors', { path: { ws } }),
  create: (ws: string, body: ConnectorInput) =>
    d4().post('/v1/workspaces/{ws}/connectors', { path: { ws }, body: body as never }),
  update: (ws: string, id: string, body: ConnectorInput) =>
    d4().patch('/v1/workspaces/{ws}/connectors/{id}', { path: { ws, id }, body: body as never }),
  remove: (ws: string, id: string) =>
    d4().delete('/v1/workspaces/{ws}/connectors/{id}', { path: { ws, id } }),
  sync: (ws: string, id: string, dryRun: boolean) =>
    d4().post('/v1/workspaces/{ws}/connectors/{id}/sync', { path: { ws, id }, body: { dryRun } }),
};
