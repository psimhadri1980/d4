import type { Lens } from '@d4/core';

/**
 * A built-in lens and the data it belongs to (CG-4): `only` the workspaces on these metamodels, or
 * every workspace `except` these. Either way it needs every type it names.
 */
export type BuiltInLens = Lens & ({ only: readonly string[]; except?: never } | { except: readonly string[]; only?: never });

const CREDIT = ['d4-credit-graph'];

/** Whether a workspace on metamodel `id` offers the lens. */
export const offeredOn = (l: BuiltInLens, id: string) => (l.only ? l.only.includes(id) : !l.except.includes(id));

/**
 * Lenses offered before anyone has saved one (LS-7): five for the starter metamodel (and the
 * metamodels built on it, except the credit graph), eleven for the credit graph only (CG-4).
 */
const STARTER_LENSES: BuiltInLens[] = [
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
    except: CREDIT,
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
    except: CREDIT,
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
    except: CREDIT,
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
    except: CREDIT,
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
    except: CREDIT,
  },
];

const facilityWith = (id: string, name: string, facet: Lens['facets'][number], layout: Lens['layout'] = 'hier'): BuiltInLens => ({
  id,
  name,
  contour: { type: 'CreditFacility' },
  facets: [facet],
  match: 'all',
  depth: 1,
  layout,
  view: 'graph',
  only: CREDIT,
});

/** The credit graph's lenses (d4-credit-graph, CG-4). */
const CREDIT_LENSES: BuiltInLens[] = [
  facilityWith('credit-margin-calls', 'Facilities with margin calls', { types: ['MarginCall'], relationship: 'RAISED_ON', direction: 'IN', link: 'has' }),
  facilityWith('credit-property-loans', 'Mortgages and property loans', { types: ['Property'], relationship: 'FINANCES', direction: 'OUT', link: 'has' }, 'flow'),
  facilityWith('credit-covenants', 'Facilities with covenants', { types: ['Covenant'], relationship: 'HAS_COVENANT', direction: 'OUT', link: 'has' }),
  {
    id: 'credit-client-margin-calls',
    name: 'Clients with margin calls',
    contour: { type: 'Client' },
    facets: [{ types: ['MarginCall'], relationship: 'ISSUED_TO', direction: 'IN', link: 'has' }],
    match: 'all',
    depth: 2,
    layout: 'hier',
    view: 'graph',
    only: CREDIT,
  },
  {
    id: 'credit-family-groups',
    name: 'Clients in a family group',
    contour: { type: 'Client' },
    facets: [{ types: ['ClientGroup'], direction: 'BOTH', link: 'has' }],
    match: 'all',
    depth: 1,
    layout: 'radial',
    view: 'graph',
    only: CREDIT,
  },
  {
    id: 'credit-applications-in-review',
    name: 'Applications in review',
    contour: { type: 'CreditApplication', attributes: [{ attribute: 'status', op: 'in', value: ['SUBMITTED', 'IN_REVIEW'] }] },
    facets: [],
    match: 'all',
    depth: 1,
    layout: 'flow',
    view: 'table',
    only: CREDIT,
  },
  {
    id: 'credit-pledged-properties',
    name: 'Pledged properties',
    contour: { type: 'Property' },
    facets: [{ types: ['CollateralAgreement'], relationship: 'PLEDGES', direction: 'IN', link: 'has' }],
    match: 'all',
    depth: 1,
    layout: 'hier',
    view: 'graph',
    only: CREDIT,
  },
  {
    id: 'credit-group-exposure',
    name: 'Group exposure',
    contour: { type: 'ClientGroup' },
    facets: [{ types: ['CreditExposure'], relationship: 'AGGREGATES_TO', direction: 'IN', link: 'has' }],
    match: 'all',
    depth: 1,
    layout: 'radial',
    view: 'graph',
    only: CREDIT,
  },
  {
    id: 'credit-ifrs-stage-2-3',
    name: 'Facilities in IFRS stage 2 or 3',
    contour: { type: 'CreditFacility', attributes: [{ attribute: 'ifrsStage', op: 'in', value: ['STAGE_2', 'STAGE_3'] }] },
    facets: [],
    match: 'all',
    depth: 1,
    layout: 'hier',
    view: 'graph',
    only: CREDIT,
  },
  facilityWith('credit-breached-covenants', 'Facilities with a breached covenant', {
    types: ['Covenant'],
    relationship: 'HAS_COVENANT',
    direction: 'OUT',
    link: 'has',
    attributes: [{ attribute: 'status', op: 'in', value: ['BREACHED'] }],
  }),
  {
    id: 'credit-large-facilities',
    name: 'Large facilities (10m and over)',
    contour: { type: 'CreditFacility', attributes: [{ attribute: 'limitAmount', op: 'gte', value: 10_000_000 }] },
    facets: [],
    match: 'all',
    depth: 1,
    layout: 'hier',
    view: 'graph',
    only: CREDIT,
  },
];

export const PREDEFINED_LENSES: BuiltInLens[] = [...STARTER_LENSES, ...CREDIT_LENSES];
