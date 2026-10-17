import type { IsoDate } from './types';

export interface Period {
  validFrom: IsoDate | null;
  validTo: IsoDate | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function periodIssues(p: Period): string[] {
  const issues: string[] = [];
  for (const k of ['validFrom', 'validTo'] as const) {
    const v = p[k];
    if (v !== null && (!DATE.test(v) || isNaN(Date.parse(v)))) issues.push(`${k} must be YYYY-MM-DD`);
  }
  if (!issues.length && p.validFrom && p.validTo && p.validFrom >= p.validTo) {
    issues.push('validFrom must be before validTo');
  }
  return issues;
}

/** Half-open periods [from, to); null bounds are open-ended. ISO dates compare as strings. */
export function overlaps(a: Period, b: Period): boolean {
  const startsBeforeEnd = (x: Period, y: Period) =>
    x.validFrom === null || y.validTo === null || x.validFrom < y.validTo;
  return startsBeforeEnd(a, b) && startsBeforeEnd(b, a);
}

/** Is the item valid on the given date? */
export function validOn(p: Period, date: IsoDate): boolean {
  return (p.validFrom === null || p.validFrom <= date) && (p.validTo === null || date < p.validTo);
}
