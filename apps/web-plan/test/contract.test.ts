import { describe, expect, it } from 'vitest';
import { lifecycleProblems } from '@d4/web-platform';
import * as mod from '../src/index';

describe('plan module', () => {
  it('meets the lifecycle contract the shell checks', () => {
    expect(lifecycleProblems(mod, 'plan')).toEqual([]);
  });

  it('records the shared majors it is built against', () => {
    expect(mod.manifest.shared).toMatchObject({ react: expect.stringMatching(/^\d+$/), '@d4/web-platform': expect.stringMatching(/^\d+$/) });
  });
});
