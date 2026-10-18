import { Command, CommanderError } from 'commander';
import {
  CodecError,
  EXPORT_FORMATS,
  parseModelDocument,
  stringifyModelDocument,
  toImportInput,
  validateModelDocument,
} from '@d4/codecs';
import { planImport } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry, parseMetamodel } from '@d4/metamodel';

/** Everything the CLI touches, injectable for tests. */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
}

class ApiError extends Error {}

interface ImportResponse {
  ok: boolean;
  applied: boolean;
  issues: { subjectId: string; ruleId?: string; message: string }[];
  elements: { created: number; updated: number; unchanged: number };
  relationships: { created: number; updated: number; unchanged: number };
}

/** Runs the CLI with the given arguments (without `node d4`) and returns the exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name('d4')
    .description('D4 model-as-code: validate, import and export workspace models.')
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const base = (io.env['D4_API_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
    const token = io.env['D4_TOKEN'];
    if (!token) throw new ApiError('D4_TOKEN is not set (deploy/dev.sh token prints one for local dev)');
    const res = await io.fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const issues = Array.isArray(body['issues']) ? `\n - ${(body['issues'] as string[]).join('\n - ')}` : '';
      throw new ApiError(`${res.status} ${String(body['error'] ?? '')}: ${String(body['message'] ?? res.statusText)}${issues}`);
    }
    return body as T;
  };

  /** For file exports: the body as text. */
  const apiText = async (path: string): Promise<string> => {
    const base = (io.env['D4_API_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
    const token = io.env['D4_TOKEN'];
    if (!token) throw new ApiError('D4_TOKEN is not set (deploy/dev.sh token prints one for local dev)');
    const res = await io.fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) {
      const body = (() => {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      throw new ApiError(`${res.status} ${String(body['error'] ?? '')}: ${String(body['message'] ?? res.statusText)}`);
    }
    return text;
  };

  const resolveWorkspace = async (ref: string): Promise<string> => {
    const list = await api<{ id: string; slug: string }[]>('/v1/workspaces');
    const ws = list.find((w) => w.id === ref || w.slug === ref);
    if (!ws) throw new ApiError(`workspace '${ref}' not found (have: ${list.map((w) => w.slug).join(', ')})`);
    return ws.id;
  };

  const printPlan = (p: Pick<ImportResponse, 'issues' | 'elements' | 'relationships'>) => {
    const c = (x: ImportResponse['elements']) => `${x.created} created, ${x.updated} updated, ${x.unchanged} unchanged`;
    io.out(`elements:      ${c(p.elements)}\n`);
    io.out(`relationships: ${c(p.relationships)}\n`);
    for (const i of p.issues) io.err(`  ✗ ${i.subjectId}${i.ruleId ? ` [${i.ruleId}]` : ''}: ${i.message}\n`);
  };

  program
    .command('validate')
    .description('Check a model document offline against a metamodel (starter by default).')
    .argument('<file>', 'model document (YAML or JSON)')
    .option('--metamodel <file>', 'metamodel YAML to validate against')
    .action(async (file: string, opts: { metamodel?: string }) => {
      const doc = parseModelDocument(await io.readFile(file));
      const mm = opts.metamodel ? parseMetamodel(await io.readFile(opts.metamodel)) : loadStarterMetamodel();
      const plan = planImport(new MetamodelRegistry(mm), { workspaceId: 'offline', actor: 'cli' }, toImportInput(doc), {
        elements: [],
        relationships: [],
      });
      printPlan(plan);
      if (plan.ok) io.out(`✓ ${file} is valid for ${mm.id}@${mm.version}\n`);
      else exitCode = 1;
    });

  program
    .command('workspaces')
    .description('List workspaces you can see.')
    .action(async () => {
      for (const w of await api<{ id: string; slug: string; name: string }[]>('/v1/workspaces')) {
        io.out(`${w.slug}\t${w.id}\t${w.name}\n`);
      }
    });

  program
    .command('import')
    .description('Import a model document into a workspace (idempotent; nothing is deleted).')
    .argument('<file>', 'model document (YAML or JSON)')
    .requiredOption('-w, --workspace <slug-or-id>', 'target workspace')
    .option('--dry-run', 'validate and report without changing anything')
    .action(async (file: string, opts: { workspace: string; dryRun?: boolean }) => {
      const doc = parseModelDocument(await io.readFile(file));
      const ws = await resolveWorkspace(opts.workspace);
      const result = await api<ImportResponse>(`/v1/workspaces/${ws}/import${opts.dryRun ? '?dryRun=true' : ''}`, {
        method: 'POST',
        body: JSON.stringify(doc),
      });
      printPlan(result);
      if (!result.ok) exitCode = 1;
      else if (opts.dryRun) io.out('✓ dry run: valid, no changes applied\n');
      else io.out(result.applied ? '✓ imported\n' : '✓ already up to date\n');
    });

  program
    .command('export')
    .description('Export a workspace: model document (yaml, json) or another format.')
    .requiredOption('-w, --workspace <slug-or-id>', 'source workspace')
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .option('--format <format>', EXPORT_FORMATS.join(' | '), 'yaml')
    .option('--as-of <date>', 'only items valid on this date (YYYY-MM-DD)')
    .option('--scenario <id>', 'the baseline plus this scenario')
    .option('--scope <ids>', 'comma-separated element ids: export their neighbourhood')
    .option('--depth <n>', 'neighbourhood depth for --scope (1-3)')
    .action(async (opts: { workspace: string; out?: string; format: string; asOf?: string; scenario?: string; scope?: string; depth?: string }) => {
      if (opts.format === 'xlsx') throw new ApiError('xlsx is binary: download it from the web app or GET /export?format=xlsx');
      if (!(EXPORT_FORMATS as readonly string[]).includes(opts.format)) {
        throw new ApiError(`unknown format '${opts.format}' (one of: ${EXPORT_FORMATS.join(', ')})`);
      }
      const ws = await resolveWorkspace(opts.workspace);
      const params = new URLSearchParams();
      if (opts.asOf) params.set('asOf', opts.asOf);
      if (opts.scenario) params.set('scenario', opts.scenario);
      if (opts.scope) params.set('scope', opts.scope);
      if (opts.depth) params.set('depth', opts.depth);
      const filtered = params.size > 0;

      let text: string;
      let summary: string;
      if (opts.format === 'yaml' || opts.format === 'json') {
        const doc = validateModelDocument(await api(`/v1/workspaces/${ws}/export${filtered ? `?${params}` : ''}`));
        text = stringifyModelDocument(doc, opts.format);
        summary = `${doc.elements.length} elements and ${doc.relationships.length} relationships`;
      } else {
        params.set('format', opts.format);
        text = await apiText(`/v1/workspaces/${ws}/export?${params}`);
        summary = `${opts.format} (${text.length} characters)`;
      }
      if (opts.out) {
        await io.writeFile(opts.out, text);
        io.out(`✓ wrote ${summary} to ${opts.out}\n`);
      } else {
        io.out(text);
      }
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    if (e instanceof CodecError || e instanceof ApiError || (e as NodeJS.ErrnoException).code === 'ENOENT') {
      io.err(`error: ${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }
  return exitCode;
}
