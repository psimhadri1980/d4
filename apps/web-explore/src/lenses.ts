import type { Lens } from '@d4/core';

/**
 * Lenses offered before anyone has saved one (LS-7). They fit the starter metamodel; a type a
 * workspace's metamodel lacks leaves its lens out. Lenses last for the session for now.
 */
export const PREDEFINED_LENSES: Lens[] = [
  {
    id: 'data-products',
    name: 'Data products',
    description: 'Every data product, with what holds, owns and uses it.',
    contour: { type: 'DataProduct' },
    facets: [],
    match: 'all',
    depth: 1,
    layout: 'hier',
    view: 'graph',
  },
  {
    id: 'mastered-data-products',
    name: 'Data products with a store',
    description: 'Data products that a data store holds.',
    contour: { type: 'DataProduct' },
    facets: [{ types: ['DataStore'], relationship: 'HOLDS', direction: 'IN', link: 'has' }],
    match: 'all',
    depth: 1,
    layout: 'flow',
    view: 'graph',
  },
  {
    id: 'critical-applications',
    name: 'Critical applications',
    description: 'Applications rated high or mission critical.',
    contour: { type: 'Application', attributes: [{ attribute: 'criticality', op: 'in', value: ['HIGH', 'MISSION_CRITICAL'] }] },
    facets: [],
    match: 'all',
    depth: 2,
    layout: 'radial',
    view: 'graph',
  },
  {
    id: 'unsupported-capabilities',
    name: 'Capabilities no application realizes',
    description: 'Capabilities with no application linked by REALIZES.',
    contour: { type: 'Capability' },
    facets: [{ types: ['Application'], relationship: 'REALIZES', direction: 'IN', link: 'none' }],
    match: 'all',
    depth: 1,
    layout: 'hier',
    view: 'table',
  },
  {
    id: 'planned-deliverables',
    name: 'Planned deliverables',
    description: 'Deliverables not started yet.',
    contour: { type: 'Deliverable', attributes: [{ attribute: 'lifecycle', op: 'eq', value: 'PLANNED' }] },
    facets: [],
    match: 'all',
    depth: 2,
    layout: 'layers',
    view: 'graph',
  },
];
