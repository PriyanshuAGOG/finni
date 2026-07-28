'use client';

import './globals.css';
import { ErrorScreen } from './components/error-screen';

/**
 * Catches errors in the root layout itself, which `error.tsx` cannot --
 * Next.js requires this file to render its own <html>/<body> since the
 * layout that would normally provide them is what failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <ErrorScreen error={error} reset={reset} />
      </body>
    </html>
  );
}
