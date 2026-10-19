import { describe, expect, it } from 'vitest';
import { Cadence, describeCadence, nextRun, runParams } from '../src';

const at = (s: string) => new Date(s);

describe('nextRun', () => {
  it('daily: later today, or tomorrow once the hour has passed', () => {
    const c = Cadence.parse({ frequency: 'daily', hour: 6 });
    expect(nextRun(c, at('2027-01-10T05:59:00Z'))).toEqual(at('2027-01-10T06:00:00Z'));
    expect(nextRun(c, at('2027-01-10T06:00:00Z'))).toEqual(at('2027-01-11T06:00:00Z'));
    expect(nextRun(c, at('2027-12-31T23:00:00Z'))).toEqual(at('2028-01-01T06:00:00Z'));
  });

  it('weekly: the next given weekday', () => {
    const monday = Cadence.parse({ frequency: 'weekly', hour: 8, weekday: 1 });
    expect(nextRun(monday, at('2027-01-06T12:00:00Z'))).toEqual(at('2027-01-11T08:00:00Z')); // Wed → Mon
    expect(nextRun(monday, at('2027-01-11T07:00:00Z'))).toEqual(at('2027-01-11T08:00:00Z'));
    expect(nextRun(monday, at('2027-01-11T08:00:00Z'))).toEqual(at('2027-01-18T08:00:00Z'));
  });

  it('monthly: the given day, rolling over the year', () => {
    const c = Cadence.parse({ frequency: 'monthly', hour: 0, day: 28 });
    expect(nextRun(c, at('2027-02-10T00:00:00Z'))).toEqual(at('2027-02-28T00:00:00Z'));
    expect(nextRun(c, at('2027-12-28T00:00:00Z'))).toEqual(at('2028-01-28T00:00:00Z'));
    expect(() => Cadence.parse({ frequency: 'monthly', hour: 0, day: 31 })).toThrow();
  });

  it('describes cadences for people', () => {
    expect(describeCadence({ frequency: 'weekly', hour: 7, weekday: 1 })).toBe('Every Monday at 07:00 UTC');
    expect(describeCadence({ frequency: 'monthly', hour: 18, day: 1 })).toBe('On day 1 of every month at 18:00 UTC');
  });
});

describe('runParams', () => {
  const run = at('2027-03-15T06:00:00Z');
  it('follows the run date when asked: as-of for exports and graphs, today for roadmaps', () => {
    expect(runParams({ kind: 'export', params: { format: 'yaml', asOf: '2026-01-01' }, useRunDate: true }, run)).toEqual({ format: 'yaml', asOf: '2027-03-15' });
    expect(runParams({ kind: 'render', params: { target: 'roadmap', format: 'pdf', scope: ['x'] }, useRunDate: true }, run)).toMatchObject({ today: '2027-03-15' });
    expect(runParams({ kind: 'render', params: { target: 'graph', format: 'png', root: 'x' }, useRunDate: true }, run)).toMatchObject({ asOf: '2027-03-15' });
    expect(runParams({ kind: 'export', params: { format: 'yaml' }, useRunDate: false }, run)).toEqual({ format: 'yaml' });
  });
});
