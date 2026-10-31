import React from 'react';
import ReactDOMClient from 'react-dom/client';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import singleSpaReact from 'single-spa-react';
import type { TabMode } from './Queries';
import { lazyPage, LIFECYCLE_CONTRACT, loadStylesheet, ModuleRoot, type LifecycleProps, type ModuleManifest } from '@d4/web-platform';
import './queries.css';

const Queries = lazyPage(() => import('./Queries'), 'Queries');

/** Earlier separate screens now open as tabs in Queries. */
function ToQueries({ mode }: { mode: TabMode }) {
  const { ws, qid } = useParams();
  return <Navigate to={`/w/${ws}/queries${qid ? `?tabs=${mode}:${qid}&active=${mode}:${qid}` : ''}`} replace />;
}

/** The query catalog, query studio and stewardship, as tabs in one screen. */
export const manifest: ModuleManifest = {
  id: 'queries',
  contract: LIFECYCLE_CONTRACT,
  shared: __D4_SHARED__,
  paths: ['queries', 'catalog', 'studio', 'stewardship'],
  nav: {
    group: 'Explore',
    order: 10,
    items: [
      {
        id: 'queries',
        label: 'Queries',
        icon: 'database-search',
        to: 'queries',
        match: ['queries', 'catalog', 'studio', 'stewardship'],
        order: 20,
        sub: [
          { label: 'Catalog', to: 'queries?section=catalog' },
          { label: 'Query studio', to: 'queries?section=studio', requires: 'author' },
          { label: 'Stewardship', to: 'queries?section=stewardship', requires: 'steward' },
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
          <Route path="/w/:ws">
            <Route path="queries" element={<Queries />} />
            <Route path="catalog/:qid?" element={<ToQueries mode="run" />} />
            <Route path="studio/:qid?" element={<ToQueries mode="edit" />} />
            <Route path="stewardship/:qid?" element={<ToQueries mode="review" />} />
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

// The stylesheet sits next to this file (vite.config.ts); the release query (`?v=`) keeps them in step.
const stylesheet = new URL(/* @vite-ignore */ `queries.css${new URL(import.meta.url).search}`, import.meta.url).href;

export const bootstrap = [() => loadStylesheet(stylesheet), react.bootstrap];
export const { mount, unmount } = react;
