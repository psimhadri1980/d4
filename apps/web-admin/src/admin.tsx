import React from 'react';
import ReactDOMClient from 'react-dom/client';
import { Navigate, Route, Routes } from 'react-router-dom';
import singleSpaReact from 'single-spa-react';
import { lazyPage, LIFECYCLE_CONTRACT, loadStylesheet, ModuleRoot, type LifecycleProps, type ModuleManifest } from '@d4/web-platform';
// Spike: the module's pages stay in apps/web; P6 moves them here.
import '../../web/src/modules/admin/admin.css';

const AdminWorkspacesPage = lazyPage(() => import('../../web/src/modules/admin/Admin'), 'AdminWorkspacesPage');
const AdminPeoplePage = lazyPage(() => import('../../web/src/modules/admin/Admin'), 'AdminPeoplePage');
const AdminWebhooksPage = lazyPage(() => import('../../web/src/modules/admin/Admin'), 'AdminWebhooksPage');
const AdminUsagePage = lazyPage(() => import('../../web/src/modules/admin/Admin'), 'AdminUsagePage');

/** Tenant administration as a lifecycle module: workspaces, people and roles, webhooks, usage. */
export const manifest: ModuleManifest = {
  id: 'admin',
  contract: LIFECYCLE_CONTRACT,
  nav: {
    group: 'Administration',
    order: 50,
    items: [
      {
        id: 'admin',
        label: 'Admin',
        icon: 'settings',
        to: 'admin/workspaces',
        match: ['admin'],
        requires: 'admin',
        sub: [
          { label: 'Workspaces', to: 'admin/workspaces' },
          { label: 'People and roles', to: 'admin/people' },
          { label: 'Webhooks', to: 'admin/webhooks' },
          { label: 'Usage', to: 'admin/usage' },
        ],
      },
    ],
  },
};

function Root({ platform }: LifecycleProps) {
  return (
    <ModuleRoot platform={platform}>
      <React.Suspense fallback={null}>
        <Routes>
          <Route path="/w/:ws/admin">
            <Route index element={<Navigate to="workspaces" replace />} />
            <Route path="workspaces" element={<AdminWorkspacesPage />} />
            <Route path="people" element={<AdminPeoplePage />} />
            <Route path="webhooks" element={<AdminWebhooksPage />} />
            <Route path="usage" element={<AdminUsagePage />} />
          </Route>
        </Routes>
      </React.Suspense>
    </ModuleRoot>
  );
}

const react = singleSpaReact({
  React,
  ReactDOMClient,
  rootComponent: Root,
  errorBoundary: (err) => (
    <div className="error-banner" role="alert">
      <strong>Something went wrong</strong>
      <div>{String(err)}</div>
    </div>
  ),
});

// The stylesheet sits next to this file (vite.config.ts).
const stylesheet = new URL(/* @vite-ignore */ 'admin.css', import.meta.url).href;

export const bootstrap = [() => loadStylesheet(stylesheet), react.bootstrap];
export const { mount, unmount } = react;
