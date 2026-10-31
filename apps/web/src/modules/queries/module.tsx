import { IconDatabaseSearch } from '@tabler/icons-react';
import { Navigate, useParams } from 'react-router-dom';
import { lazyPage, MODULE_CONTRACT, type D4Module } from '@d4/web-platform';
import type { TabMode } from './Queries';
import './queries.css';

const Queries = lazyPage(() => import('./Queries'), 'Queries');

/** Earlier separate screens now open as tabs in Queries. */
function ToQueries({ mode }: { mode: TabMode }) {
  const { ws, qid } = useParams();
  return <Navigate to={`/w/${ws}/queries${qid ? `?tabs=${mode}:${qid}&active=${mode}:${qid}` : ''}`} replace />;
}

/** The query catalog, query studio and stewardship, as tabs in one screen. */
export const queriesModule: D4Module = {
  id: 'queries',
  contract: MODULE_CONTRACT,
  nav: {
    group: 'Explore',
    order: 10,
    items: [
      {
        id: 'queries',
        label: 'Queries',
        icon: IconDatabaseSearch,
        to: 'queries',
        match: ['queries', 'catalog', 'studio', 'stewardship'],
        order: 20,
        sub: [
          { label: 'Catalog', to: 'queries?section=catalog' },
          { label: 'Query studio', to: 'queries?section=studio', visible: (a) => a.author },
          { label: 'Stewardship', to: 'queries?section=stewardship', visible: (a) => a.steward },
        ],
      },
    ],
  },
  routes: [
    { path: 'queries', element: <Queries /> },
    { path: 'catalog/:qid?', element: <ToQueries mode="run" /> },
    { path: 'studio/:qid?', element: <ToQueries mode="edit" /> },
    { path: 'stewardship/:qid?', element: <ToQueries mode="review" /> },
  ],
};
