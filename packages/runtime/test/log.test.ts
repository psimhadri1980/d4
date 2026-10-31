import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src';

describe('createLogger', () => {
  it('writes one JSON object per line with time, level, service and message', () => {
    const lines: string[] = [];
    const out = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    createLogger('d4-test', out).info({ jobId: 'j1', ms: 5 }, 'job done');
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'info', service: 'd4-test', message: 'job done', jobId: 'j1', ms: 5 });
    expect(new Date(entry.time).toISOString()).toBe(entry.time);
  });
});
