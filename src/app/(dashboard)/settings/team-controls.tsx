'use client';

import { useActionState, useTransition } from 'react';
import { inviteMemberAction, revokeInvitationAction, type InviteMemberState } from '../../actions/team';

const initialState: InviteMemberState = { error: null, success: null };

export function InviteMemberForm({ roles }: { roles: Array<{ slug: string; name: string }> }) {
  const [state, formAction, pending] = useActionState(inviteMemberAction, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="invite_full_name">Name</label>
          <input id="invite_full_name" name="full_name" type="text" required className="input" />
        </div>
        <div>
          <label className="label" htmlFor="invite_email">Email</label>
          <input id="invite_email" name="email" type="email" required className="input" />
        </div>
        <div>
          <label className="label" htmlFor="invite_role">Role</label>
          <select id="invite_role" name="role_slug" required className="input">
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.success && <p className="text-sm text-emerald-600">{state.success}</p>}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? 'Sending…' : 'Send invitation'}
      </button>
    </form>
  );
}

export function RevokeInvitationButton({ invitationId }: { invitationId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      className="btn btn-secondary text-xs"
      onClick={() => {
        if (!confirm('Revoke this invitation? The link will stop working immediately.')) return;
        startTransition(() => {
          void revokeInvitationAction(invitationId);
        });
      }}
    >
      {pending ? 'Revoking…' : 'Revoke'}
    </button>
  );
}
