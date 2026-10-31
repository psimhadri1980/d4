import React from 'react';
import ReactDOMClient from 'react-dom/client';
import { Route, Routes } from 'react-router-dom';
import singleSpaReact from 'single-spa-react';
import { lazyPage, LIFECYCLE_CONTRACT, loadStylesheet, ModuleRoot, type LifecycleProps, type ModuleManifest } from '@d4/web-platform';
import './reporting.css';

const Reports = lazyPage(() => import('./Reports'), 'Reports');
const Jobs = lazyPage(() => import('./Jobs'), 'Jobs');

/** Scheduled reports and the background jobs that produce files. */
export const manifest: ModuleManifest = {
  id: 'reporting',
  contract: LIFECYCLE_CONTRACT,
  shared: __D4_SHARED__,
  paths: ['reports', 'jobs'],
  nav: {
    group: 'Reporting',
    order: 40,
    items: [
      { id: 'reports', label: 'Reports', icon: 'report', to: 'reports', match: ['reports'] },
      { id: 'jobs', label: 'Jobs', icon: 'list-check', to: 'jobs', match: ['jobs'] },
    ],
  },
};

function Root({ platform }: LifecycleProps) {
  return (
    <ModuleRoot platform={platform}>
      <React.Suspense fallback={null}>
        <Routes>
          <Route path="/w/:ws">
            <Route path="reports" element={<Reports />} />
            <Route path="jobs" element={<Jobs />} />
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
const stylesheet = new URL(/* @vite-ignore */ `reporting.css${new URL(import.meta.url).search}`, import.meta.url).href;

export const bootstrap = [() => loadStylesheet(stylesheet), react.bootstrap];
export const { mount, unmount } = react;
