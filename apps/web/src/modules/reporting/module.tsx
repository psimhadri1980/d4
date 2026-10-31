import { IconListCheck, IconReport } from '@tabler/icons-react';
import { lazyPage, MODULE_CONTRACT, type D4Module } from '@d4/web-platform';
import './reporting.css';

const Reports = lazyPage(() => import('./Reports'), 'Reports');
const Jobs = lazyPage(() => import('./Jobs'), 'Jobs');

/** Scheduled reports and the background jobs that produce files. */
export const reportingModule: D4Module = {
  id: 'reporting',
  contract: MODULE_CONTRACT,
  nav: {
    group: 'Reporting',
    order: 40,
    items: [
      { id: 'reports', label: 'Reports', icon: IconReport, to: 'reports', match: ['reports'] },
      { id: 'jobs', label: 'Jobs', icon: IconListCheck, to: 'jobs', match: ['jobs'] },
    ],
  },
  routes: [
    { path: 'reports', element: <Reports /> },
    { path: 'jobs', element: <Jobs /> },
  ],
};
