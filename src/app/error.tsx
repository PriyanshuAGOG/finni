'use client';

import { ErrorScreen } from './components/error-screen';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return <ErrorScreen error={error} reset={reset} />;
}
