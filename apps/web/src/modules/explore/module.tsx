import { IconArrowsDiff, IconHierarchy3, IconTable } from '@tabler/icons-react';
import { lazyPage, MODULE_CONTRACT, type D4Module } from '@d4/web-platform';
import './explore.css';

const Explorer = lazyPage(() => import('./Explorer'), 'Explorer');
const ElementEditor = lazyPage(() => import('./ElementEditor'), 'ElementEditor');
const Matrices = lazyPage(() => import('./Matrices'), 'Matrices');
const Compare = lazyPage(() => import('./Compare'), 'Compare');

/** The model: Explorer (the workspace home, element pages and the element editor), matrices, Compare. */
export const exploreModule: D4Module = {
  id: 'explore',
  contract: MODULE_CONTRACT,
  nav: {
    group: 'Explore',
    order: 10,
    items: [
      { id: 'explorer', label: 'Explorer', icon: IconHierarchy3, to: '', match: ['', 'e/', 'new'], order: 10 },
      {
        id: 'matrices',
        label: 'Matrices',
        icon: IconTable,
        to: 'matrices',
        match: ['matrices'],
        order: 30,
        sub: [
          { label: 'CRUD-I', to: 'matrices' },
          { label: 'Capability × application', to: 'matrices?kind=capability-application' },
          { label: 'Data-store roles', to: 'matrices?kind=data-store-roles' },
          { label: 'Lifecycle heat-map', to: 'matrices?kind=lifecycle' },
        ],
      },
      { id: 'compare', label: 'Compare', icon: IconArrowsDiff, to: 'compare', match: ['compare'], order: 40 },
    ],
  },
  routes: [
    { index: true, element: <Explorer /> },
    { path: 'e/:id', element: <Explorer /> },
    { path: 'new', element: <ElementEditor mode="create" /> },
    { path: 'e/:id/edit', element: <ElementEditor mode="edit" /> },
    { path: 'matrices', element: <Matrices /> },
    { path: 'compare', element: <Compare /> },
  ],
};
