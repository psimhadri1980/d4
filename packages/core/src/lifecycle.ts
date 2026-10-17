import { DomainError } from './errors';

export const LIFECYCLE = [
  'IDEA',
  'PROPOSED',
  'DECIDED',
  'PLANNED',
  'IN_DEVELOPMENT',
  'LIVE',
  'DEPRECATED',
  'RETIRED',
] as const;
export type LifecycleState = (typeof LIFECYCLE)[number];

export const INITIAL_LIFECYCLE: LifecycleState = 'IDEA';

/**
 * Allowed moves. Forward along the design → delivery path, a step back for rework before
 * delivery starts, early retirement (rejected/cancelled) before go-live, and un-deprecation.
 * RETIRED is terminal.
 */
const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  IDEA: ['PROPOSED', 'RETIRED'],
  PROPOSED: ['DECIDED', 'IDEA', 'RETIRED'],
  DECIDED: ['PLANNED', 'PROPOSED', 'RETIRED'],
  PLANNED: ['IN_DEVELOPMENT', 'DECIDED', 'RETIRED'],
  IN_DEVELOPMENT: ['LIVE', 'PLANNED', 'RETIRED'],
  LIVE: ['DEPRECATED'],
  DEPRECATED: ['RETIRED', 'LIVE'],
  RETIRED: [],
};

export const isLifecycleState = (v: unknown): v is LifecycleState =>
  typeof v === 'string' && (LIFECYCLE as readonly string[]).includes(v);

export function allowedTransitions(from: LifecycleState): readonly LifecycleState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from];
    throw new DomainError(
      'INVALID_TRANSITION',
      `Lifecycle cannot move from ${from} to ${to}` +
        (allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (terminal state)'),
    );
  }
}
