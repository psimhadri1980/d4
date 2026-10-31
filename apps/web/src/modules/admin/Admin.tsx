import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { Usage } from './Usage';
import { Webhooks } from './Webhooks';
import { keys, ROLES } from '@d4/web-platform';
import { adminApi, type AdminWorkspace } from './api';
import { AdminGate, ErrorBanner } from '@d4/ui-kit';

const toSlug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);


export const AdminWorkspacesPage = () => (
  <AdminGate title="Workspaces">
    <Workspaces />
  </AdminGate>
);

export function AdminPeoplePage() {
  const { ws } = useParams();
  return (
    <AdminGate title="People and roles">
      <Members defaultScope={ws!} />
    </AdminGate>
  );
}

export const AdminWebhooksPage = () => (
  <AdminGate title="Webhooks">
    <Webhooks />
  </AdminGate>
);

export const AdminUsagePage = () => (
  <AdminGate title="Usage">
    <Usage />
  </AdminGate>
);

function Workspaces() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: keys.adminWorkspaces, queryFn: adminApi.workspaces });
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [pack, setPack] = useState('d4-starter');
  const packs = useQuery({ queryKey: ['admin', 'metamodel-packs'], queryFn: adminApi.metamodelPacks });
  const nameId = useId();
  const slugId = useId();
  const packId = useId();
  const chosenPack = packs.data?.find((p) => p.id === pack);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
    } catch (e) {
      setError(e);
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await adminApi.createWorkspace({ name, slug, metamodel: pack });
      setName('');
      setSlug('');
      setSlugTouched(false);
      setPack('d4-starter');
    });
  };

  return (
    <section className="card" aria-label="Workspaces">
      <div className="card-head">
        <h3>Workspaces</h3>
      </div>
      {list.error && <ErrorBanner error={list.error} />}
      {error != null && <ErrorBanner error={error} />}
      <table className="jobs" aria-label="All workspaces">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Slug</th>
            <th scope="col">Metamodel</th>
            <th scope="col">Status</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {list.data?.map((w: AdminWorkspace) => (
            <tr key={w.id} className={w.archived ? 'paused' : ''}>
              <td>
                {renaming?.id === w.id ? (
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(() => adminApi.updateWorkspace(w.id, { name: renaming.name })).then(() => setRenaming(null));
                    }}
                  >
                    <input aria-label={`New name for ${w.name}`} value={renaming.name} onChange={(e) => setRenaming({ id: w.id, name: e.target.value })} required />
                    <button className="button small primary" type="submit">
                      Save
                    </button>
                    <button className="button small ghost" type="button" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  w.name
                )}
              </td>
              <td className="small mono">{w.slug}</td>
              <td className="small mono">{w.metamodel ?? '—'}</td>
              <td>{w.archived ? <span className="badge muted">archived</span> : <span className="badge job-succeeded">active</span>}</td>
              <td className="row-actions">
                <button className="button small ghost" onClick={() => setRenaming({ id: w.id, name: w.name })}>
                  Rename
                </button>
                <button
                  className="button small ghost"
                  onClick={() => {
                    if (w.archived || window.confirm(`Archive "${w.name}"? It disappears for everyone except admins. Nothing is deleted.`)) {
                      void act(() => adminApi.setArchived(w.id, !w.archived));
                    }
                  }}
                >
                  {w.archived ? 'Restore' : 'Archive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="admin-create" aria-label="New workspace" onSubmit={create}>
        <div className="field">
          <label htmlFor={nameId}>New workspace name</label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(toSlug(e.target.value));
            }}
            required
            maxLength={120}
          />
        </div>
        <div className="field">
          <label htmlFor={slugId}>Slug</label>
          <input
            id={slugId}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            required
            pattern="[a-z0-9][a-z0-9-]{1,47}"
            title="Lowercase letters, digits and dashes"
          />
        </div>
        <div className="field">
          <label htmlFor={packId}>Metamodel</label>
          <select id={packId} value={pack} onChange={(e) => setPack(e.target.value)}>
            {(packs.data ?? [{ id: 'd4-starter', version: '', description: '', addedNodeTypes: 0, addedRelationshipTypes: 0 }]).map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === 'd4-starter' ? 'Starter' : p.id.replace(/^d4-/, '').replace(/^./, (c) => c.toUpperCase())}
                {p.addedNodeTypes ? ` (+${p.addedNodeTypes} types)` : ''}
              </option>
            ))}
          </select>
        </div>
        <button className="button primary" type="submit">
          Create workspace
        </button>
        {chosenPack && chosenPack.id !== 'd4-starter' && <p className="muted small pack-note">{chosenPack.description}</p>}
      </form>
    </section>
  );
}

function Members({ defaultScope }: { defaultScope: string }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState(defaultScope);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('');
  const [error, setError] = useState<unknown>(null);
  const scopeId = useId();
  const userSel = useId();
  const roleSel = useId();
  const workspaces = useQuery({ queryKey: keys.adminWorkspaces, queryFn: adminApi.workspaces });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users });
  const members = useQuery({ queryKey: ['admin', 'members', scope], queryFn: () => adminApi.members(scope) });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'members', scope] });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section className="card" aria-label="Members and roles">
      <div className="card-head">
        <h3>Members and roles</h3>
      </div>
      <p className="muted small">
        Roles from the identity provider apply everywhere. Here you grant extra roles tenant-wide or for one workspace. People appear in the list after
        their first sign-in.
      </p>
      <div className="field narrow">
        <label htmlFor={scopeId}>Roles for</label>
        <select id={scopeId} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="tenant">The whole tenant</option>
          {workspaces.data
            ?.filter((w) => !w.archived)
            .map((w) => (
              <option key={w.id} value={w.id}>
                Workspace: {w.name}
              </option>
            ))}
        </select>
      </div>
      {error != null && <ErrorBanner error={error} />}
      {members.data && members.data.length === 0 && <p className="muted small">No roles granted here yet.</p>}
      {members.data && members.data.length > 0 && (
        <table className="jobs" aria-label="Role bindings">
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">Role</th>
              <th scope="col">Granted</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={`${m.principalType}:${m.principalId}:${m.role}`}>
                <td>
                  {m.label} {m.principalType === 'group' && <span className="badge muted">group</span>}
                </td>
                <td>{m.role}</td>
                <td className="small">{new Date(m.createdAt).toLocaleDateString()}</td>
                <td className="row-actions">
                  <button className="link danger" aria-label={`Remove ${m.role} from ${m.label}`} onClick={() => void act(() => adminApi.revoke(scope, m))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="admin-create"
        aria-label="Grant a role"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await adminApi.grant(scope, userId, role);
            setUserId('');
            setRole('');
          });
        }}
      >
        <div className="field">
          <label htmlFor={userSel}>Person</label>
          <select id={userSel} value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">— choose a person —</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email ?? u.displayName ?? u.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={roleSel}>Role</label>
          <select id={roleSel} value={role} onChange={(e) => setRole(e.target.value)} required>
            <option value="">— choose a role —</option>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <button className="button primary" type="submit" disabled={!userId || !role}>
          Grant
        </button>
      </form>
    </section>
  );
}
