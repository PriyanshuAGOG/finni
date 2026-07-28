'use client';

import { useEffect, useState } from 'react';

interface ErrorScreenProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Full error-boundary screen: reports the error once on mount (so it
 * lands in error_logs even if the user never mentions it), then shows a
 * plain-language message with the request digest for support and a way
 * to retry without a full page reload.
 */
export function ErrorScreen({ error, reset }: ErrorScreenProps): React.ReactElement {
  const [reported, setReported] = useState(false);

  useEffect(() => {
    fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: error.message || 'Unknown rendering error',
        stack: error.stack,
        url: typeof window !== 'undefined' ? window.location.href : undefined,
        kind: 'react_render',
        context: { digest: error.digest },
      }),
      keepalive: true,
    })
      .catch(() => undefined)
      .finally(() => setReported(true));
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="card max-w-md p-6 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-600">
          !
        </div>
        <h1 className="text-base font-semibold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">
          This has been recorded{reported ? '' : ' (saving now…)'} so it can be fixed. You can try again,
          or go back and pick up where you left off.
        </p>
        {error.digest && (
          <p className="mt-3 text-xs text-slate-400">
            Reference: <code className="font-mono">{error.digest}</code>
          </p>
        )}
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" className="btn btn-primary" onClick={reset}>
            Try again
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => window.location.assign('/')}>
            Go home
          </button>
        </div>
      </div>
    </div>
  );
}
