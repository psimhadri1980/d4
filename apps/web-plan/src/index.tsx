import React from 'react';
import ReactDOMClient from 'react-dom/client';
import { Route, Routes } from 'react-router-dom';
import singleSpaReact from 'single-spa-react';
import { lazyPage, LIFECYCLE_CONTRACT, loadStylesheet, ModuleRoot, type LifecycleProps, type ModuleManifest } from '@d4/web-platform';
import './plan.css';

const Roadmap = lazyPage(() => import('./Roadmap'), 'Roadmap');
const Decisions = lazyPage(() => import('./Decisions'), 'Decisions');
const Proposals = lazyPage(() => import('./Proposals'), 'Proposals');

/** Planning and governance: the roadmap, decision records and change proposals. */
export const manifest: ModuleManifest = {
  id: 'plan',
  contract: LIFECYCLE_CONTRACT,
  shared: __D4_SHARED__,
  paths: ['roadmap', 'decisions', 'proposals'],
  nav: {
    group: 'Plan and govern',
    order: 20,
    items: [
      { id: 'roadmap', label: 'Roadmap', icon: 'timeline', to: 'roadmap', match: ['roadmap'] },
      { id: 'decisions', label: 'Decisions', icon: 'gavel', to: 'decisions', match: ['decisions'] },
      {
        id: 'proposals',
        label: 'Proposals',
        icon: 'git-pull-request',
        to: 'proposals',
        match: ['proposals'],
        sub: [
          { label: 'Open', to: 'proposals?show=open' },
          { label: 'Waiting for review', to: 'proposals?show=review' },
          { label: 'Closed', to: 'proposals?show=closed' },
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
            <Route path="roadmap" element={<Roadmap />} />
            <Route path="decisions" element={<Decisions />} />
            <Route path="proposals/:pid?" element={<Proposals />} />
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
const stylesheet = new URL(/* @vite-ignore */ `plan.css${new URL(import.meta.url).search}`, import.meta.url).href;

export const bootstrap = [() => loadStylesheet(stylesheet), react.bootstrap];
export const { mount, unmount } = react;
