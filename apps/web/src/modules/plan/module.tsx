import { IconGavel, IconGitPullRequest, IconTimeline } from '@tabler/icons-react';
import { lazyPage, MODULE_CONTRACT, type D4Module } from '@d4/web-platform';
import './plan.css';

const Roadmap = lazyPage(() => import('./Roadmap'), 'Roadmap');
const Decisions = lazyPage(() => import('./Decisions'), 'Decisions');
const Proposals = lazyPage(() => import('./Proposals'), 'Proposals');

/** Planning and governance: the roadmap, decision records and change proposals. */
export const planModule: D4Module = {
  id: 'plan',
  contract: MODULE_CONTRACT,
  nav: {
    group: 'Plan and govern',
    order: 20,
    items: [
      { id: 'roadmap', label: 'Roadmap', icon: IconTimeline, to: 'roadmap', match: ['roadmap'] },
      { id: 'decisions', label: 'Decisions', icon: IconGavel, to: 'decisions', match: ['decisions'] },
      {
        id: 'proposals',
        label: 'Proposals',
        icon: IconGitPullRequest,
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
  routes: [
    { path: 'roadmap', element: <Roadmap /> },
    { path: 'decisions', element: <Decisions /> },
    { path: 'proposals/:pid?', element: <Proposals /> },
  ],
};
