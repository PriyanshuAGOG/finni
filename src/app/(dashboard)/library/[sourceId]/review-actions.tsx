'use client';

import { useState, useTransition } from 'react';
import { archiveSourceWithConfirmationAction } from './actions';

export function SourceActions({ sourceId, title }: { sourceId: string; title: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await archiveSourceWithConfirmationAction(sourceId, title);
            if (result.error) setError(result.error);
          });
        }}
        className="btn btn-secondary"
      >
        Archive
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
