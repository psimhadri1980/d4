import { D4ApiError } from '@d4/web-platform';

/** Shows API errors with their code, issues and rule id. */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof D4ApiError ? error : null;
  return (
    <div className="error-banner" role="alert">
      <strong>{e ? friendly(e) : 'Something went wrong'}</strong>
      <div>{e?.message ?? String(error)}</div>
      {e?.ruleId && <div className="muted">Rule: {e.ruleId}</div>}
      {!!e?.issues.length && (
        <ul>
          {e.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function friendly(e: D4ApiError): string {
  switch (e.code) {
    case 'VERSION_CONFLICT':
      return 'Someone else changed this in the meantime — reload and try again.';
    case 'RULE_VIOLATION':
      return 'This would break a modelling rule.';
    case 'INVALID_TRANSITION':
      return 'That lifecycle change is not allowed.';
    case 'LOCKED':
      return 'This workspace is being restored. Try again in a few minutes.';
    case 'QUOTA_EXCEEDED':
      return 'Your plan limit is reached. An admin can see usage on the Admin page.';
    case 'VALIDATION':
    case 'BAD_REQUEST':
      return 'Some values are not valid.';
    case 'FORBIDDEN':
      return 'You do not have permission to do this.';
    case 'NOT_FOUND':
      return 'Not found.';
    default:
      return `Error ${e.status}`;
  }
}
