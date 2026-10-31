import React from 'react';
import ReactDOMClient from 'react-dom/client';
import { Route, Routes } from 'react-router-dom';
import singleSpaReact from 'single-spa-react';
import { lazyPage, LIFECYCLE_CONTRACT, loadStylesheet, ModuleRoot, type LifecycleProps, type ModuleManifest } from '@d4/web-platform';
import './data.css';

const Import = lazyPage(() => import('./Import'), 'Import');
const ConnectorsPage = lazyPage(() => import('./Connectors'), 'ConnectorsPage');
const BackupsPage = lazyPage(() => import('./Backups'), 'BackupsPage');

/** Getting data in and keeping it safe: spreadsheet import, connectors and backups. */
export const manifest: ModuleManifest = {
  id: 'data',
  contract: LIFECYCLE_CONTRACT,
  shared: __D4_SHARED__,
  paths: ['import', 'connectors', 'backups'],
  nav: {
    group: 'Data management',
    order: 30,
    items: [
      { id: 'import', label: 'Import', icon: 'file-import', to: 'import', match: ['import'] },
      { id: 'connectors', label: 'Connectors', icon: 'plug-connected', to: 'connectors', match: ['connectors'], requires: 'admin' },
      { id: 'backups', label: 'Backups', icon: 'database-export', to: 'backups', match: ['backups'], requires: 'admin' },
    ],
  },
};

function Root({ platform }: LifecycleProps) {
  return (
    <ModuleRoot platform={platform}>
      <React.Suspense fallback={null}>
        <Routes>
          <Route path="/w/:ws">
            <Route path="import" element={<Import />} />
            <Route path="connectors" element={<ConnectorsPage />} />
            <Route path="backups" element={<BackupsPage />} />
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
const stylesheet = new URL(/* @vite-ignore */ `data.css${new URL(import.meta.url).search}`, import.meta.url).href;

export const bootstrap = [() => loadStylesheet(stylesheet), react.bootstrap];
export const { mount, unmount } = react;
