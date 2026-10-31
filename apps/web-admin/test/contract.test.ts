import { describe, expect, it } from 'vitest';
import { lifecycleProblems } from '@d4/web-platform';
import * as admin from '../src/index';

describe('admin module', () => {
  it('meets the lifecycle contract the shell checks', () => {
    expect(lifecycleProblems(admin, 'admin')).toEqual([]);
  });

  it('records the shared majors it is built against', () => {
    expect(admin.manifest.shared).toMatchObject({ react: expect.stringMatching(/^\d+$/), '@d4/web-platform': expect.stringMatching(/^\d+$/) });
  });
});
