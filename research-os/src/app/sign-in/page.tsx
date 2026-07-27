'use client';

import { use, useActionState } from 'react';
import { signInAction, type SignInState } from '../actions/auth';

const initialState: SignInState = { error: null };

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const [state, formAction, pending] = useActionState(signInAction, initialState);
  const resolvedSearchParams = use(searchParams);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white font-semibold">
            NB
          </div>
          <h1 className="text-lg font-semibold text-slate-900">Nirog Bhoomi Research OS</h1>
          <p className="text-sm text-slate-500">Sign in to continue</p>
        </div>

        <form action={formAction} className="card space-y-4 p-6">
          <input type="hidden" name="next" value={resolvedSearchParams?.next ?? '/'} />

          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="input"
              placeholder="you@nirogbhoomi.dev"
            />
          </div>

          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="input"
            />
          </div>

          {state.error && (
            <p role="alert" className="text-sm text-red-600">
              {state.error}
            </p>
          )}

          <button type="submit" disabled={pending} className="btn btn-primary w-full">
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          After running <code className="rounded bg-slate-100 px-1 py-0.5">npm run db:seed</code>, sign in
          as admin@nirogbhoomi.dev / DevPassword123!
        </p>
      </div>
    </div>
  );
}
