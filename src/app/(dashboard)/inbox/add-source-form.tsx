'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { addSourceAction, type AddSourceState } from '../../actions/sources';

const initialState: AddSourceState = { error: null, success: null };

export function AddSourceForm() {
  const [state, formAction, pending] = useActionState(addSourceAction, initialState);

  return (
    <div className="card p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-900">Add a source</h2>
      <form action={formAction} className="flex flex-wrap items-start gap-2">
        <input
          name="url"
          type="url"
          required
          placeholder="https://example.com/article"
          className="input min-w-[20rem] flex-1"
        />
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? 'Adding…' : 'Add'}
        </button>
      </form>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {state.error}{' '}
          {state.duplicateSourceId && (
            <Link href={`/library/${state.duplicateSourceId}`} className="underline">
              Open it
            </Link>
          )}
        </p>
      )}
      {state.success && <p className="mt-2 text-sm text-emerald-600">{state.success}</p>}
    </div>
  );
}
