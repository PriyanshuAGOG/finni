'use client';

import { useEffect } from 'react';

function report(message: string, stack: string | undefined, kind: string): void {
  const payload = {
    message,
    stack,
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    kind,
  };
  // `keepalive` lets this survive a navigation the error itself might
  // trigger (e.g. a crash right before the user clicks away).
  fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Catches what a React error boundary cannot: uncaught exceptions in
 * event handlers, timers and async code, plus unhandled promise
 * rejections (a fetch failing, for instance) anywhere in the dashboard.
 * Mounted once in the root layout.
 */
export function ErrorReporter(): null {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      report(event.message || 'Unknown window error', event.error?.stack, 'window_error');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      report(message, stack, 'unhandled_rejection');
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
