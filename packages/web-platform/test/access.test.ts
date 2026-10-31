import { describe, expect, it } from 'vitest';
import { accessOf } from '../src/access';

describe('accessOf', () => {
  it('gives nothing without roles', () => {
    expect(accessOf(undefined)).toEqual({
      admin: false,
      author: false,
      steward: false,
      reviewer: false,
    });
  });

  it('maps catalog and review roles', () => {
    expect(accessOf(['query-author'])).toMatchObject({
      author: true,
      steward: false,
      admin: false,
    });
    expect(accessOf(['query-steward'])).toMatchObject({ steward: true, author: false });
    expect(accessOf(['architect'])).toMatchObject({ reviewer: true, admin: false });
  });

  it('lets admins do everything', () => {
    expect(accessOf(['admin'])).toEqual({
      admin: true,
      author: true,
      steward: true,
      reviewer: true,
    });
  });
});
