// Console output and subprocesses. Every step prints what it does and the command it runs; each
// subprocess writes its full output to a log file under run/.run/logs (and the session log), and a
// failure prints the command, its exit code, the last lines of its output and where the log is.
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

const tty = process.stderr.isTTY && !process.env['NO_COLOR'];
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'), blue: paint('34'), cyan: paint('36') };

export const opts = { verbose: false, yes: false };
let logDir = '';
let sessionLog = '';

export function initLogs(dir: string): void {
  logDir = dir;
  mkdirSync(dir, { recursive: true });
  sessionLog = join(dir, 'run.log');
  appendFileSync(sessionLog, `\n==== ${new Date().toISOString()} run.sh ${process.argv.slice(2).join(' ')}\n`);
}

const stamp = () => new Date().toTimeString().slice(0, 8);
function write(line: string): void {
  process.stderr.write(line + '\n');
  if (sessionLog) appendFileSync(sessionLog, line.replace(/\x1b\[[0-9;]*m/g, '') + '\n');
}

export const log = {
  /** A top-level phase: `==> Building 3 components`. */
  phase: (msg: string) => write(`${c.dim(stamp())} ${c.bold(c.blue('==>'))} ${c.bold(msg)}`),
  /** One step for one component: `[2/5] api  build`. */
  step: (i: number, n: number, comp: string, what: string) =>
    write(`${c.dim(stamp())} ${c.cyan(`[${i}/${n}]`)} ${c.bold(comp.padEnd(14))} ${what}`),
  info: (msg: string) => write(`${c.dim(stamp())}     ${msg}`),
  detail: (msg: string) => write(`${c.dim(stamp())}       ${c.dim(msg)}`),
  cmd: (cmd: string) => write(`${c.dim(stamp())}       ${c.dim('$ ' + (opts.verbose || cmd.length <= 240 ? cmd : cmd.slice(0, 240) + ' …'))}`),
  ok: (msg: string) => write(`${c.dim(stamp())}     ${c.green('✓')} ${msg}`),
  warn: (msg: string) => write(`${c.dim(stamp())}     ${c.yellow('!')} ${c.yellow(msg)}`),
  error: (msg: string) => write(`${c.dim(stamp())}     ${c.red('✗')} ${c.red(msg)}`),
  raw: (msg: string) => write(msg),
};

/** A failure the CLI reports and exits on: what failed, why, and where to look. */
export class RunError extends Error {
  readonly hint: string | undefined;
  readonly tail: string[];
  readonly logFile: string | undefined;
  readonly code: number;
  constructor(message: string, o: { hint?: string; tail?: string[]; logFile?: string; code?: number } = {}) {
    super(message);
    this.hint = o.hint;
    this.tail = o.tail ?? [];
    this.logFile = o.logFile;
    this.code = o.code ?? 1;
  }
}

export function reportError(e: unknown): number {
  if (e instanceof RunError) {
    write('');
    write(c.red(c.bold('✗ FAILED: ')) + c.red(e.message));
    if (e.tail.length) {
      write(c.dim('─'.repeat(30) + ' last output ' + '─'.repeat(30)));
      for (const l of e.tail) write('  ' + l);
      write(c.dim('─'.repeat(73)));
    }
    if (e.logFile) write(`  full log: ${e.logFile}`);
    if (e.hint) write(`  ${c.yellow('hint:')} ${e.hint}`);
    write(`  session log: ${sessionLog}`);
    return e.code;
  }
  const err = e as Error;
  write(c.red(c.bold('✗ UNEXPECTED ERROR: ')) + c.red(err?.message ?? String(e)));
  if (err?.stack) write(c.dim(err.stack));
  return 1;
}

export const elapsed = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Log file name under run/.run/logs (default: the session log only). */
  logName?: string;
  /** Printed with the heartbeat while the command runs (`building api image`). */
  label?: string;
  /** Called for every output line (progress parsing). */
  onLine?: (line: string) => void;
  /** Exit codes that count as success. */
  okCodes?: number[];
  /** Pass stdin/stdout/stderr straight through (interactive commands, `logs -f`). */
  inherit?: boolean;
  /** Print the command line (default true). */
  quiet?: boolean;
  /** Hint printed with a failure. */
  hint?: string;
}

interface ExecResult {
  code: number;
  out: string;
  tail: string[];
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const cmdline = (cmd: string, args: string[]) => [cmd, ...args].map(quote).join(' ');

/**
 * Runs a command, logging its output to a file; resolves with the exit code and output. Throws a
 * RunError (with the command, exit code and output tail) unless the code is in okCodes.
 */
export function exec(cmd: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
  const line = cmdline(cmd, args);
  if (!o.quiet) log.cmd(line);
  const file = o.logName ? join(logDir, o.logName) : sessionLog;
  const stream: WriteStream | undefined = file ? createWriteStream(file, { flags: 'a' }) : undefined;
  stream?.write(`\n---- ${new Date().toISOString()} $ ${line}\n`);
  const spawnOpts: SpawnOptions = { cwd: o.cwd, env: o.env ?? process.env, stdio: o.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, spawnOpts);
    const tail: string[] = [];
    let out = '';
    let last = '';
    let partial = '';
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      out += text;
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
      stream?.write(text);
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) {
        const clean = l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        if (!clean.trim()) continue;
        last = clean;
        tail.push(clean);
        if (tail.length > 40) tail.shift();
        if (opts.verbose) write(c.dim(`       │ ${clean}`));
        o.onLine?.(clean);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const beat = o.label && !opts.verbose && !o.inherit
      ? setInterval(() => log.detail(`… ${o.label} (${elapsed(started)})${last ? ': ' + last.slice(0, 110) : ''}`), 10_000)
      : undefined;
    child.on('error', (e) => {
      if (beat) clearInterval(beat);
      stream?.end();
      reject(new RunError(`could not run '${cmd}': ${e.message}`, { hint: o.hint ?? `is '${cmd}' installed and on PATH?` }));
    });
    child.on('close', (code, signal) => {
      if (beat) clearInterval(beat);
      if (partial.trim()) tail.push(partial);
      const exit = code ?? (signal ? 128 : 1);
      stream?.write(`---- exit ${exit}${signal ? ` (${signal})` : ''} after ${elapsed(started)}\n`);
      stream?.end();
      if ((o.okCodes ?? [0]).includes(exit)) return resolve({ code: exit, out, tail });
      reject(new RunError(`${o.label ?? 'command'} failed (exit ${exit}${signal ? `, ${signal}` : ''}): ${line}`, { tail, logFile: file, hint: o.hint }));
    });
  });
}

/** A quick command whose output is needed (podman inspect, git): never logged as a step. */
export function capture(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: 127, out: '', err: r.error.message };
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** capture, without blocking: for checks run side by side (status). */
export function captureAsync(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: 127, out, err: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
