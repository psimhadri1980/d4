import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { adminApi, type WebModule } from './api';
import { ErrorBanner } from '@d4/ui-kit';

const EMPTY = { name: '', title: '', entry: '', version: '', framework: 'react', owner: '', description: '' };

/**
 * The module registry (D64): web modules the app loads at run time. Changes reach open pages
 * within about 30 seconds, without a reload: a new release replaces the running one.
 */
export function Modules() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'web-modules'], queryFn: adminApi.webModules });
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(EMPTY);
  const ids = { name: useId(), title: useId(), entry: useId(), version: useId(), framework: useId(), owner: useId(), description: useId() };
  const field = (k: keyof typeof EMPTY) => ({ id: ids[k], value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'web-modules'] });
    } catch (e) {
      setError(e);
    }
  };
  const put = (m: Pick<WebModule, 'name' | 'title' | 'entry' | 'version' | 'framework' | 'enabled'> & { owner?: string | null; description?: string | null }) =>
    adminApi.putWebModule(m.name, { title: m.title, entry: m.entry, version: m.version, contract: 2, framework: m.framework, enabled: m.enabled, owner: m.owner || null, description: m.description || null });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const existing = list.data?.find((m) => m.name === form.name);
    void act(async () => {
      await put({ ...form, framework: form.framework as WebModule['framework'], entry: form.entry || `/mfe/${form.name}/${form.name}.js`, enabled: existing?.enabled ?? true });
      setForm(EMPTY);
    });
  };
  const edit = (m: WebModule) => setForm({ name: m.name, title: m.title, entry: m.entry, version: m.version, framework: m.framework, owner: m.owner ?? '', description: m.description ?? '' });

  return (
    <section className="card" aria-label="Modules">
      <div className="card-head">
        <h3>Modules</h3>
      </div>
      <p className="muted small">
        Parts of D4 loaded at run time. Each owns the pages under its name and is served from <code>/mfe/&lt;name&gt;/</code>. Open pages pick up changes within about 30
        seconds.
      </p>
      {list.error && <ErrorBanner error={list.error} />}
      {error != null && <ErrorBanner error={error} />}
      {list.data && list.data.length === 0 && <p className="muted small">No modules registered.</p>}
      {list.data && list.data.length > 0 && (
        <table className="jobs" aria-label="Registered modules">
          <thead>
            <tr>
              <th scope="col">Module</th>
              <th scope="col">Release</th>
              <th scope="col">Owner</th>
              <th scope="col">Status</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((m) => (
              <tr key={m.name}>
                <td>
                  <strong>{m.title}</strong> <span className="muted mono small">{m.name}</span>
                  {m.description && <div className="muted small">{m.description}</div>}
                </td>
                <td>
                  <span className="mono small">{m.version}</span>
                  <div className="muted small">
                    {m.framework}, contract {m.contract}
                  </div>
                </td>
                <td>{m.owner ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`badge ${m.enabled ? 'job-succeeded' : ''}`}>{m.enabled ? 'on' : 'off'}</span>
                </td>
                <td className="actions">
                  <button className="link-button" onClick={() => edit(m)}>
                    New release
                  </button>{' '}
                  <button className="link-button" onClick={() => void act(() => put({ ...m, enabled: !m.enabled }))}>
                    {m.enabled ? 'Turn off' : 'Turn on'}
                  </button>{' '}
                  <button className="link-button danger" onClick={() => window.confirm(`Remove the module '${m.title}'?`) && void act(() => adminApi.removeWebModule(m.name))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="admin-create" aria-label="Register a module" onSubmit={submit}>
        <div className="field">
          <label htmlFor={ids.name}>Name</label>
          <input {...field('name')} required pattern="[a-z][a-z0-9-]{1,31}" placeholder="plan" />
        </div>
        <div className="field">
          <label htmlFor={ids.title}>Title</label>
          <input {...field('title')} required maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor={ids.version}>Version</label>
          <input {...field('version')} required maxLength={40} placeholder="1.0.0" />
        </div>
        <div className="field wide">
          <label htmlFor={ids.entry}>Entry</label>
          <input {...field('entry')} placeholder={`/mfe/${form.name || '<name>'}/${form.name || '<name>'}.js`} />
        </div>
        <div className="field">
          <label htmlFor={ids.framework}>Framework</label>
          <select {...field('framework')}>
            <option value="react">React</option>
            <option value="vanilla">Plain JavaScript</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.owner}>Owner</label>
          <input {...field('owner')} maxLength={80} />
        </div>
        <div className="field wide">
          <label htmlFor={ids.description}>Description</label>
          <input {...field('description')} maxLength={500} />
        </div>
        <button className="button primary" type="submit">
          {list.data?.some((m) => m.name === form.name) ? 'Save release' : 'Register module'}
        </button>
      </form>
    </section>
  );
}
