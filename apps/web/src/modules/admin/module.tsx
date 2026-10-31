import { IconSettings } from '@tabler/icons-react';
import { Navigate } from 'react-router-dom';
import { lazyPage, MODULE_CONTRACT, type D4Module } from '@d4/web-platform';
import './admin.css';

const AdminWorkspacesPage = lazyPage(() => import('./Admin'), 'AdminWorkspacesPage');
const AdminPeoplePage = lazyPage(() => import('./Admin'), 'AdminPeoplePage');
const AdminWebhooksPage = lazyPage(() => import('./Admin'), 'AdminWebhooksPage');
const AdminUsagePage = lazyPage(() => import('./Admin'), 'AdminUsagePage');

/** Tenant administration: workspaces, people and roles, webhooks, usage. */
export const adminModule: D4Module = {
  id: 'admin',
  contract: MODULE_CONTRACT,
  nav: {
    group: 'Administration',
    order: 50,
    items: [
      {
        id: 'admin',
        label: 'Admin',
        icon: IconSettings,
        to: 'admin/workspaces',
        match: ['admin'],
        visible: (a) => a.admin,
        sub: [
          { label: 'Workspaces', to: 'admin/workspaces' },
          { label: 'People and roles', to: 'admin/people' },
          { label: 'Webhooks', to: 'admin/webhooks' },
          { label: 'Usage', to: 'admin/usage' },
        ],
      },
    ],
  },
  routes: [
    { path: 'admin', element: <Navigate to="workspaces" replace /> },
    { path: 'admin/workspaces', element: <AdminWorkspacesPage /> },
    { path: 'admin/people', element: <AdminPeoplePage /> },
    { path: 'admin/webhooks', element: <AdminWebhooksPage /> },
    { path: 'admin/usage', element: <AdminUsagePage /> },
  ],
};
