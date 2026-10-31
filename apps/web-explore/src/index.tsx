import React from 'react';
import ReactDOMClient from 'react-dom/client';
import { Route, Routes } from 'react-router-dom';
import singleSpaReact from 'single-spa-react';
import { lazyPage, LIFECYCLE_CONTRACT, loadStylesheet, ModuleRoot, type LifecycleProps, type ModuleManifest } from '@d4/web-platform';
import './explore.css';

const Explorer = lazyPage(() => import('./Explorer'), 'Explorer');
const ElementEditor = lazyPage(() => import('./ElementEditor'), 'ElementEditor');
const Matrices = lazyPage(() => import('./Matrices'), 'Matrices');
const Compare = lazyPage(() => import('./Compare'), 'Compare');

/** The model: Explorer (the workspace home, element pages and the element editor), matrices, Compare. */
export const manifest: ModuleManifest = {
  id: 'explore',
  contract: LIFECYCLE_CONTRACT,
  shared: __D4_SHARED__,
  // The workspace home (/w/:ws) as well as these paths.
  home: true,
  paths: ['e', 'new', 'matrices', 'compare'],
  nav: {
    group: 'Explore',
    order: 10,
    items: [
      { id: 'explorer', label: 'Explorer', icon: 'hierarchy', to: '', match: ['', 'e/', 'new'], order: 10 },
      {
        id: 'matrices',
        label: 'Matrices',
        icon: 'table',
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
      { id: 'compare', label: 'Compare', icon: 'arrows-diff', to: 'compare', match: ['compare'], order: 40 },
    ],
  },
};

function Root({ platform }: LifecycleProps) {
  return (
    <ModuleRoot platform={platform}>
      <React.Suspense fallback={null}>
        <Routes>
          <Route path="/w/:ws">
            <Route index element={<Explorer />} />
            <Route path="e/:id" element={<Explorer />} />
            <Route path="new" element={<ElementEditor mode="create" />} />
            <Route path="e/:id/edit" element={<ElementEditor mode="edit" />} />
            <Route path="matrices" element={<Matrices />} />
            <Route path="compare" element={<Compare />} />
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
const stylesheet = new URL(/* @vite-ignore */ `explore.css${new URL(import.meta.url).search}`, import.meta.url).href;

export const bootstrap = [() => loadStylesheet(stylesheet), react.bootstrap];
export const { mount, unmount } = react;
