export type DomainErrorCode =
  | 'VALIDATION' // attributes, connection or validity period invalid for the metamodel
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT' // optimistic concurrency: expectedVersion did not match
  | 'INVALID_TRANSITION' // lifecycle transition not allowed
  | 'RULE_VIOLATION' // a metamodel rule (acyclic, uniqueness) would be broken
  | 'QUOTA_EXCEEDED'; // the tenant's plan limit would be exceeded

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly issues: string[] = [],
    /** Rule id for RULE_VIOLATION. */
    readonly ruleId?: string,
  ) {
    super(issues.length ? `${message}: ${issues.join('; ')}` : message);
    this.name = 'DomainError';
  }
}
