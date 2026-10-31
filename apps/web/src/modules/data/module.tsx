import { IconDatabaseExport, IconFileImport, IconPlugConnected } from '@tabler/icons-react';
import { lazyPage, MODULE_CONTRACT, type Access, type D4Module } from '@d4/web-platform';
import './data.css';

const Import = lazyPage(() => import('./Import'), 'Import');
const ConnectorsPage = lazyPage(() => import('./Connectors'), 'ConnectorsPage');
const BackupsPage = lazyPage(() => import('./Backups'), 'BackupsPage');

const admins = (a: Access) => a.admin;

/** Getting data in and keeping it safe: spreadsheet import, connectors and backups. */
export const dataModule: D4Module = {
  id: 'data',
  contract: MODULE_CONTRACT,
  nav: {
    group: 'Data management',
    order: 30,
    items: [
      { id: 'import', label: 'Import', icon: IconFileImport, to: 'import', match: ['import'] },
      { id: 'connectors', label: 'Connectors', icon: IconPlugConnected, to: 'connectors', match: ['connectors'], visible: admins },
      { id: 'backups', label: 'Backups', icon: IconDatabaseExport, to: 'backups', match: ['backups'], visible: admins },
    ],
  },
  routes: [
    { path: 'import', element: <Import /> },
    { path: 'connectors', element: <ConnectorsPage /> },
    { path: 'backups', element: <BackupsPage /> },
  ],
};
