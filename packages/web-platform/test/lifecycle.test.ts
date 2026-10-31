import { describe, expect, it } from 'vitest';
import { LIFECYCLE_CONTRACT, lifecycleProblems } from '../src/lifecycle';

const fn = async () => undefined;
const good = {
  manifest: { id: 'hello', contract: LIFECYCLE_CONTRACT, nav: { group: 'Labs', order: 1, items: [{ id: 'hello', label: 'Hello', icon: 'flask', to: 'hello', match: ['hello'] }] } },
  bootstrap: [fn],
  mount: fn,
  unmount: fn,
};

describe('lifecycleProblems', () => {
  it('accepts a module that meets the contract', () => {
    expect(lifecycleProblems(good, 'hello')).toEqual([]);
  });

  it('names what is wrong', () => {
    expect(lifecycleProblems({}, 'hello')[0]).toMatch(/contract undefined/);
    expect(lifecycleProblems({ ...good, manifest: { ...good.manifest, contract: 1 } }, 'hello')[0]).toMatch(/contract 1/);
    expect(lifecycleProblems(good, 'other')).toContain("calls itself 'hello'");
    expect(lifecycleProblems({ ...good, mount: [] }, 'hello')).toContain('does not export mount as a function or a list of functions');
    const outside = { ...good, manifest: { ...good.manifest, nav: { ...good.manifest.nav, items: [{ ...good.manifest.nav.items[0]!, to: 'admin/x' }] } } };
    expect(lifecycleProblems(outside, 'hello')).toContain("menu path 'admin/x' is outside hello/");
  });

  it('refuses a module built against other shared majors', () => {
    const built = { ...good, manifest: { ...good.manifest, shared: { react: '18', '@d4/web-platform': '0' } } };
    expect(lifecycleProblems(built, 'hello', { react: '18', '@d4/web-platform': '0' })).toEqual([]);
    expect(lifecycleProblems(built, 'hello', { react: '19', '@d4/web-platform': '0' })).toEqual(['was built against react 18; this app shares 19']);
    expect(lifecycleProblems(built, 'hello')).toEqual([]);
  });
});
