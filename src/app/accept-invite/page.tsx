'use client';

import { use, useActionState } from 'react';
import { acceptInviteAction, type AcceptInviteState } from '../actions/auth';

const initialState: AcceptInviteState = { error: null };

export default function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const [state, formAction, pending] = useActionState(acceptInviteAction, initialState);
  const resolvedSearchParams = use(searchParams);
  const token = resolvedSearchParams?.token ?? '';

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white font-semibold">
            NB
          </div>
          <h1 className="text-lg font-semibold text-slate-900">Accept your invitation</h1>
          <p className="text-sm text-slate-500">Set a password to activate your account</p>
        </div>

        {!token ? (
          <div className="card p-6 text-sm text-red-600">
            This invitation link is missing its token. Ask whoever invited you to resend it.
          </div>
        ) : (
          <form action={formAction} className="card space-y-4 p-6">
            <input type="hidden" name="token" value={token} />

            <div>
              <label className="label" htmlFor="full_name">Your name</label>
              <input id="full_name" name="full_name" type="text" autoComplete="name" className="input" />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="input"
              />
            </div>

            <div>
              <label className="label" htmlFor="confirm_password">Confirm password</label>
              <input
                id="confirm_password"
                name="confirm_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="input"
              />
            </div>

            {state.error && (
              <p role="alert" className="text-sm text-red-600">
                {state.error}
              </p>
            )}

            <button type="submit" disabled={pending} className="btn btn-primary w-full">
              {pending ? 'Activating…' : 'Activate account'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
