// A lifecycle module without a framework or a build step (P6 spike): it proves the shell's
// contract is not tied to React. Everything it needs comes in through `props.platform`.

/** @type {import('@d4/web-platform').ModuleManifest} */
export const manifest = {
  id: 'hello',
  contract: 2,
  nav: { group: 'Labs', order: 60, items: [{ id: 'hello', label: 'Hello', icon: 'flask', to: 'hello', match: ['hello'] }] },
};

let el;

export async function bootstrap() {}

export async function mount({ platform, domElementGetter }) {
  el = domElementGetter();
  el.innerHTML = `
    <section class="card" aria-label="Hello">
      <div class="card-head"><h3>Hello from a plain JavaScript module</h3></div>
      <p class="muted small">No React, no build: this page is one ES module the shell imported.</p>
      <dl><dt>Workspace</dt><dd data-field="ws"></dd><dt>Signed in as</dt><dd data-field="me">…</dd></dl>
      <button type="button" class="button">Go to the workspace start page</button>
    </section>`;
  el.querySelector('[data-field="ws"]').textContent = platform.workspace() ?? '';
  el.querySelector('button').addEventListener('click', () => platform.navigate(`/w/${platform.workspace()}`));
  // The shell's query cache: the shell has usually fetched /v1/me already.
  const me = await platform.queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => platform.client().get('/v1/me') });
  if (el) el.querySelector('[data-field="me"]').textContent = `${me.subject} (${(me.roles ?? []).join(', ')})`;
}

export async function unmount() {
  el.innerHTML = '';
  el = undefined;
}
