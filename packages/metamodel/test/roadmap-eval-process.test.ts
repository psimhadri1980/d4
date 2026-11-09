import { describe, expect, it } from 'vitest';
import { bar, delivers, reg, edge, effective, get, lateDependencies, node, problems, sources, span, targets, type Graph } from './roadmap-eval-kit';

/**
 * Evaluation 2: can roadmap.yaml carry the business side: capabilities, shared processes down to
 * steps, roles, data created, read and updated by steps, and use cases that
 * change a process, and trace a data product's delivery to the processes that depend on it?
 *
 * Customer due diligence (CDD) is a sub-process shared by Onboarding and Lending. Its step
 * CaptureCustomer creates Customer360, its step ScoreRisk reads the RiskProfile data product, and a use
 * case augments CDD with AI. All dates fall in Q3 or Q4 2026.
 */

function scenario(): Graph {
  const nodes = [
    node('OnboardCustomers', 'Capability', { lifecycle: 'LIVE' }),
    node('Onboarding', 'Process', { level: 'L1', lifecycle: 'LIVE' }),
    node('Lending', 'Process', { level: 'L1', lifecycle: 'LIVE' }),
    node('CDD', 'Process', { level: 'L2', lifecycle: 'LIVE' }),
    node('CaptureCustomer', 'Process', { level: 'STEP', lifecycle: 'LIVE' }),
    node('ScoreRisk', 'Process', { level: 'STEP', lifecycle: 'LIVE' }),
    node('RelationshipManager', 'Role'),
    node('CreditOperations', 'Role'),
    node('RiskAnalyst', 'Role'),
    node('Customer360', 'DataProduct', { level: 'SOURCE_ALIGNED', lifecycle: 'PLANNED' }),
    node('RiskProfile', 'DataProduct', { level: 'CONSUMER_ALIGNED', lifecycle: 'PLANNED' }),
    node('RiskProfile.out', 'OutputPort', { contractVersion: '1.0' }),
    node('OnboardingApp', 'ApplicationElement', { kind: 'APPLICATION', lifecycle: 'BUILDING' }),
    node('Onboarding2026', 'Initiative', { level: 'INITIATIVE', status: 'ACTIVE' }),
    node('DataRoadmap', 'Initiative', { level: 'INITIATIVE', status: 'ACTIVE' }),
    node('AutomateDD', 'UseCase', { statement: 'Automate due diligence', painPoints: 'Manual checks take days and are inconsistent' }),
    bar('Milestone', 'OB.M0', '2026-07-01', '2026-09-15'),
    bar('Milestone', 'OB.M1', '2026-09-01', '2026-11-30'),
    bar('Milestone', 'DP.M1', '2026-08-01', '2026-10-31'),
    bar('Milestone', 'DP.M2', '2026-09-15', '2026-12-15'),
  ];
  const edges = [
    // Capability, shared process and steps.
    edge('REALISES_CAPABILITY', 'Onboarding', 'OnboardCustomers'),
    edge('REALISES_CAPABILITY', 'Lending', 'OnboardCustomers'),
    edge('PART_OF', 'CDD', 'Onboarding'),
    edge('PART_OF', 'CDD', 'Lending'),
    edge('PART_OF', 'CaptureCustomer', 'CDD'),
    edge('PART_OF', 'ScoreRisk', 'CDD'),
    // Roles, with their line of defence on the role.
    edge('PARTICIPATES_IN', 'RelationshipManager', 'CaptureCustomer', { participation: 'PERFORMS' }),
    edge('PARTICIPATES_IN', 'CreditOperations', 'ScoreRisk', { participation: 'PERFORMS' }),
    edge('PARTICIPATES_IN', 'RiskAnalyst', 'ScoreRisk', { participation: 'APPROVES' }),
    edge('PARTICIPATES_IN', 'RiskAnalyst', 'CDD', { participation: 'OVERSEES' }),
    // Data: a step creates Customer360, another reads RiskProfile through its output port.
    edge('PART_OF', 'RiskProfile.out', 'RiskProfile'),
    edge('WRITES', 'CaptureCustomer', 'Customer360', { operation: 'CREATE', strength: 'HARD' }),
    edge('READS', 'ScoreRisk', 'RiskProfile.out', { strength: 'HARD' }),
    edge('USES', 'CDD', 'OnboardingApp', { strength: 'HARD' }),
    // Delivery: the initiative that changes CDD, and the data roadmap that delivers the two products.
    edge('PART_OF', 'OB.M0', 'Onboarding2026'),
    edge('PART_OF', 'OB.M1', 'Onboarding2026'),
    edge('PART_OF', 'DP.M1', 'DataRoadmap'),
    edge('PART_OF', 'DP.M2', 'DataRoadmap'),
    delivers('OB.M0', 'OnboardingApp'),
    delivers('OB.M1', 'CDD'),
    delivers('DP.M1', 'RiskProfile'),
    delivers('DP.M2', 'Customer360'),
    // The use case: driven by an initiative, with no dates of its own, acting on a process.
    edge('REALISES', 'Onboarding2026', 'AutomateDD'),
    edge('CHANGES', 'AutomateDD', 'CDD', { changeKind: 'AUGMENT_WITH_AI' }),
  ];
  return { nodes, edges };
}

/** Everything inside a process: its sub-processes and steps. */
const within = (g: Graph, process: string): string[] => [process, ...sources(g, 'PART_OF', process).filter((c) => get(g, c).type === 'Process').flatMap((c) => within(g, c))];
/** The processes above a process, up to the top level (a shared one has several paths). */
const above = (g: Graph, process: string): string[] => targets(g, 'PART_OF', process).filter((p) => get(g, p).type === 'Process').flatMap((p) => [p, ...above(g, p)]);
const unique = (xs: string[]) => [...new Set(xs)].sort();

/** The data product lens: every process that touches a product, how, and through which step. */
function processesTouching(g: Graph, product: string) {
  const ports = sources(g, 'PART_OF', product).filter((p) => ['OutputPort', 'DataSet'].includes(get(g, p).type));
  return [
    ...g.edges.filter((e) => e.rel === 'WRITES' && e.to === product).map((e) => ({ step: e.from, operation: e.attrs?.operation as string })),
    ...g.edges.filter((e) => e.rel === 'READS' && (e.to === product || ports.includes(e.to))).map((e) => ({ step: e.from, operation: 'READ' })),
  ]
    .filter((r, i, all) => all.findIndex((x) => x.step === r.step && x.operation === r.operation) === i)
    .sort((a, b) => a.step.localeCompare(b.step));
}

/** What a slip of a line item reaches: who depends on it, what that delivers, and the processes and use cases behind it. */
function reach(g: Graph, item: string) {
  const dependents = effective(g).filter((f) => f.on === item).map((f) => f.dependent);
  const delivered = dependents.flatMap((d) => g.edges.filter((e) => e.rel === 'DELIVERS' && e.from === d).map((e) => e.to));
  const processes = delivered.filter((d) => get(g, d).type === 'Process');
  const affected = unique([...processes, ...processes.flatMap((p) => above(g, p))]);
  return { items: dependents, delivers: delivered, processes: affected, useCases: unique(g.edges.filter((e) => e.rel === 'CHANGES' && processes.includes(e.to)).map((e) => e.from)) };
}

describe('evaluation 2: capabilities, processes, roles and data on one roadmap', () => {
  const g = scenario();

  it('is valid against the metamodel', () => {
    expect(problems(g)).toEqual([]);
  });

  describe('capability, process and step', () => {
    it('shares a sub-process between two processes, with its steps below it', () => {
      expect(targets(g, 'PART_OF', 'CDD').sort()).toEqual(['Lending', 'Onboarding']);
      expect(within(g, 'CDD').sort()).toEqual(['CDD', 'CaptureCustomer', 'ScoreRisk']);
      expect(get(g, 'ScoreRisk').attrs.level).toBe('STEP');
    });

    it('keeps the capability an optional anchor: processes realise it, and nothing else needs it', () => {
      expect(sources(g, 'REALISES_CAPABILITY', 'OnboardCustomers').sort()).toEqual(['Lending', 'Onboarding']);
      const without: Graph = { nodes: g.nodes.filter((n) => n.id !== 'OnboardCustomers'), edges: g.edges.filter((e) => e.to !== 'OnboardCustomers') };
      expect(problems(without)).toEqual([]);
    });
  });

  describe('roles', () => {
    it('keeps the kind of participation on the link, and carries no line of defence on the role', () => {
      expect(reg.nodeType('Role')?.attributes).toEqual([]);
      const rolesOf = (process: string) => g.edges.filter((e) => e.rel === 'PARTICIPATES_IN' && within(g, process).includes(e.to)).map((e) => `${e.from}:${e.attrs?.participation}`).sort();
      expect(rolesOf('CDD')).toEqual(['CreditOperations:PERFORMS', 'RelationshipManager:PERFORMS', 'RiskAnalyst:APPROVES', 'RiskAnalyst:OVERSEES']);
    });

    it('requires a kind of participation', () => {
      const bad: Graph = { ...g, edges: [...g.edges, edge('PARTICIPATES_IN', 'RiskAnalyst', 'Lending')] };
      expect(problems(bad)).toEqual(['PARTICIPATES_IN RiskAnalyst -> Lending: participation is required']);
    });
  });

  describe('use case', () => {
    it('has no dates of its own and is timed through the initiative that drives it', () => {
      expect(get(g, 'AutomateDD').attrs.start).toBeUndefined();
      const drivers = sources(g, 'REALISES', 'AutomateDD');
      expect(drivers).toEqual(['Onboarding2026']);
      expect(span(g, drivers[0]!)).toEqual({ start: '2026-07-01', end: '2026-11-30' });
    });

    it('acts on a process with a kind of change, and one initiative can drive many use cases', () => {
      expect(g.edges.find((e) => e.rel === 'CHANGES' && e.to === 'CDD')?.attrs?.changeKind).toBe('AUGMENT_WITH_AI');
      const more: Graph = {
        nodes: [...g.nodes, node('DigitiseLending', 'UseCase', { statement: 'Digitise lending intake' })],
        edges: [...g.edges, edge('REALISES', 'Onboarding2026', 'DigitiseLending'), edge('CHANGES', 'DigitiseLending', 'Lending', { changeKind: 'DIGITISE' })],
      };
      expect(problems(more)).toEqual([]);
      expect(sources(more, 'REALISES', 'DigitiseLending')).toEqual(['Onboarding2026']);
    });

    it('can be linked to a milestone or an epic instead of the initiative', () => {
      const viaMilestone: Graph = { ...g, edges: g.edges.map((e) => (e.rel === 'REALISES' ? edge('REALISES', 'OB.M1', 'AutomateDD') : e)) };
      expect(problems(viaMilestone)).toEqual([]);
    });
  });

  describe('the data product lens', () => {
    it('shows which processes create, read or update a product, from the product side', () => {
      expect(processesTouching(g, 'Customer360')).toEqual([{ step: 'CaptureCustomer', operation: 'CREATE' }]);
      expect(processesTouching(g, 'RiskProfile')).toEqual([{ step: 'ScoreRisk', operation: 'READ' }]); // through its output port
    });

    it('reaches the processes above a step, so a shared sub-process shows every process it serves', () => {
      expect(unique(above(g, 'ScoreRisk'))).toEqual(['CDD', 'Lending', 'Onboarding']);
    });

    it('allows reading only through an output port or a current data set, and a write only with an operation', () => {
      const direct: Graph = { ...g, edges: [...g.edges, edge('READS', 'ScoreRisk', 'Customer360')] };
      expect(problems(direct)).toEqual(['READS: Process -> DataProduct is not allowed']);
      const noOp: Graph = { ...g, edges: g.edges.map((e) => (e.rel === 'WRITES' ? edge('WRITES', e.from, e.to) : e)) };
      expect(problems(noOp)).toEqual(['WRITES CaptureCustomer -> Customer360: operation is required']);
    });
  });

  describe('a step can read and write many data products and data sets', () => {
    // ScoreRisk also reads a data set under the RiskProfile product and a current data set no product holds;
    // CaptureCustomer also updates that current data set.
    const many: Graph = {
      nodes: [...g.nodes, node('RiskScores', 'DataSet', { lifecycle: 'PLANNED' }), node('CustomerMasterFile', 'DataSet', { lifecycle: 'LIVE', major: true })],
      edges: [
        ...g.edges,
        edge('PART_OF', 'RiskScores', 'RiskProfile'),
        edge('READS', 'ScoreRisk', 'RiskScores', { strength: 'HARD' }),
        edge('READS', 'ScoreRisk', 'CustomerMasterFile'),
        edge('WRITES', 'CaptureCustomer', 'CustomerMasterFile', { operation: 'UPDATE' }),
      ],
    };

    it('is valid, and lists everything the step reads', () => {
      expect(problems(many)).toEqual([]);
      expect(targets(many, 'READS', 'ScoreRisk').sort()).toEqual(['CustomerMasterFile', 'RiskProfile.out', 'RiskScores']);
      expect(targets(many, 'WRITES', 'CaptureCustomer').sort()).toEqual(['Customer360', 'CustomerMasterFile']);
    });

    it('shows the step against the product from the product side, whether it reads the port or a data set under the product', () => {
      expect(processesTouching(many, 'RiskProfile')).toEqual([{ step: 'ScoreRisk', operation: 'READ' }]);
    });

    it('derives the dependency of a data set under a product from the product, and none for current data nobody is delivering', () => {
      const reads = effective(many).filter((f) => f.via?.startsWith('READS')).sort((a, b) => (a.via ?? '').localeCompare(b.via ?? ''));
      expect(reads.map((f) => [f.via, f.dependent, f.on, f.float])).toEqual([
        ['READS ScoreRisk -> RiskProfile.out', 'OB.M1', 'DP.M1', 30],
        ['READS ScoreRisk -> RiskScores', 'OB.M1', 'DP.M1', 30],
      ]);
    });
  });

  describe('dependencies derived from the facts, in both directions', () => {
    it('derives them from what a process uses, reads and writes, so nobody records them twice', () => {
      const d = effective(g).sort((a, b) => (a.via ?? '').localeCompare(b.via ?? ''));
      expect(d.map((f) => [f.via, f.dependent, f.on, f.float])).toEqual([
        ['READS ScoreRisk -> RiskProfile.out', 'OB.M1', 'DP.M1', 30], // the process waits for the data: 30 Nov against 31 Oct
        ['USES CDD -> OnboardingApp', 'OB.M1', 'OB.M0', 76],
        ['WRITES CaptureCustomer -> Customer360', 'DP.M2', 'OB.M1', 15], // the product waits for the process that creates its data
      ]);
      expect(lateDependencies(g)).toEqual([]);
    });
  });

  describe('when the roadmap is at risk: the RiskProfile product slips to 15 December', () => {
    const slipped: Graph = { ...g, nodes: g.nodes.map((n) => (n.id === 'DP.M1' ? { ...n, attrs: { ...n.attrs, end: '2026-12-15' } } : n)) };

    it('makes the process change late, naming the data it waits for', () => {
      expect(lateDependencies(slipped).map((f) => [f.via, f.dependent, f.on, f.float])).toEqual([['READS ScoreRisk -> RiskProfile.out', 'OB.M1', 'DP.M1', -15]]);
    });

    it('traces it to the processes and use cases behind it, including every process the shared sub-process serves', () => {
      expect(reach(slipped, 'DP.M1')).toEqual({ items: ['OB.M1'], delivers: ['CDD'], processes: ['CDD', 'Lending', 'Onboarding'], useCases: ['AutomateDD'] });
    });
  });
});
