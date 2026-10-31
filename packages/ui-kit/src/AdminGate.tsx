import type { ReactNode } from 'react';
import { useAccess } from '@d4/web-platform';

/** Admin screens share one gate: without the admin role they say so instead of rendering. */
export function AdminGate({ title, children }: { title: string; children: ReactNode }) {
  const access = useAccess();
  if (access && !access.admin) {
    return (
      <div className="admin-page">
        <p className="muted">Administration needs the admin role.</p>
      </div>
    );
  }
  return (
    <div className="admin-page">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
