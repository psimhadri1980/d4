import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  overlaps,
  periodIssues,
  ulid,
  ULID_PATTERN,
  validOn,
} from '../src';

describe('ulid', () => {
  it('is 26 Crockford chars and sorts by time', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(ULID_PATTERN);
    expect(a < b).toBe(true);
    expect(ulid()).not.toBe(ulid());
  });
});

describe('lifecycle', () => {
  it('allows forward, rework and early retirement', () => {
    expect(canTransition('IDEA', 'PROPOSED')).toBe(true);
    expect(canTransition('DECIDED', 'PROPOSED')).toBe(true);
    expect(canTransition('PLANNED', 'RETIRED')).toBe(true);
    expect(canTransition('DEPRECATED', 'LIVE')).toBe(true);
    expect(canTransition('LIVE', 'LIVE')).toBe(true);
  });

  it('blocks skipping and leaving terminal state', () => {
    expect(canTransition('IDEA', 'LIVE')).toBe(false);
    expect(canTransition('LIVE', 'IN_DEVELOPMENT')).toBe(false);
    expect(allowedTransitions('RETIRED')).toEqual([]);
    expect(() => assertTransition('RETIRED', 'LIVE')).toThrow(/terminal/);
    expect(() => assertTransition('IDEA', 'LIVE')).toThrow(/allowed: PROPOSED, RETIRED/);
  });
});

describe('validity periods', () => {
  const p = (validFrom: string | null, validTo: string | null) => ({ validFrom, validTo });

  it('validates format and order', () => {
    expect(periodIssues(p('2026-01-01', '2027-01-01'))).toEqual([]);
    expect(periodIssues(p('2026-13-01', null))).toEqual(['validFrom must be YYYY-MM-DD']);
    expect(periodIssues(p('2027-01-01', '2026-01-01'))).toEqual(['validFrom must be before validTo']);
  });

  it('treats periods as half-open with open-ended nulls', () => {
    expect(overlaps(p(null, null), p('2026-01-01', null))).toBe(true);
    expect(overlaps(p('2026-01-01', '2026-06-01'), p('2026-06-01', null))).toBe(false);
    expect(overlaps(p('2026-01-01', '2026-06-02'), p('2026-06-01', null))).toBe(true);
    expect(validOn(p('2026-01-01', '2026-06-01'), '2026-06-01')).toBe(false);
    expect(validOn(p('2026-01-01', '2026-06-01'), '2026-01-01')).toBe(true);
  });
});
