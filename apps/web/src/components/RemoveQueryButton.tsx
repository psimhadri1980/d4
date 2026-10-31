import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBanner } from './ErrorBanner';
import { catalogApi, type QueryVersion } from '../modules/queries/api';

/** Delete (never published) or archive (has published history) a catalog entry. */
export function RemoveQueryButton({
  queryId,
  title,
  versions,
  onRemoved,
}: {
  queryId: string;
  title: string;
  versions: QueryVersion[];
  /** Called once removed (e.g. to close the tab). */
  onRemoved(): void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const archive = versions.some((v) => v.publishedAt);
  const verb = archive ? 'Archive' : 'Delete';

  const run = async () => {
    const msg = archive
      ? `Archive "${title}"? It disappears from the catalog; its versions and run history are kept.`
      : `Delete "${title}" and its drafts? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    try {
      await catalogApi.remove(queryId);
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onRemoved();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <button className="button danger" onClick={() => void run()}>
        {verb} query
      </button>
      <ErrorBanner error={error} />
    </>
  );
}
