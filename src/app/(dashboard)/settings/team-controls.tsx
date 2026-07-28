'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  editMemberAction,
  inviteMemberAction,
  reactivateMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  type EditMemberState,
  type InviteMemberState,
} from '../../actions/team';

const initialState: InviteMemberState = { error: null, success: null };
const editInitialState: EditMemberState = { error: null, success: null };

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

export function MemberRowActions({
  userId,
  currentUserId,
  status,
  roles,
}: {
  userId: string;
  currentUserId: string;
  status: string;
  roles: Array<{ slug: string; name: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState(editMemberAction, editInitialState);
  const [removePending, startRemove] = useTransition();
  const [reactivatePending, startReactivate] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);

  if (userId === currentUserId) {
    return <span className="text-xs text-slate-400">(you)</span>;
  }

  if (editing) {
    return (
      <form action={editAction} className="flex flex-wrap items-center gap-1.5">
        <input type="hidden" name="user_id" value={userId} />
        <input name="full_name" type="text" placeholder="New name" className="input w-28 text-xs" />
        <select name="role_slug" className="input w-28 text-xs" defaultValue="">
          <option value="">(role unchanged)</option>
          {roles.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={editPending} className="btn btn-primary text-xs">
          {editPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {editState.error && <span className="text-xs text-red-600">{editState.error}</span>}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditing(true)}>
        Edit
      </button>
      {status === 'deactivated' || status === 'suspended' ? (
        <button
          type="button"
          disabled={reactivatePending}
          className="btn btn-secondary text-xs"
          onClick={() => startReactivate(() => void reactivateMemberAction(userId))}
        >
          {reactivatePending ? 'Restoring…' : 'Reactivate'}
        </button>
      ) : (
        <button
          type="button"
          disabled={removePending}
          className="btn btn-secondary text-xs"
          onClick={() => {
            if (!confirm('Remove this member? They will immediately lose access; this can be undone.')) return;
            setRemoveError(null);
            startRemove(async () => {
              const result = await removeMemberAction(userId);
              if (result.error) setRemoveError(result.error);
            });
          }}
        >
          {removePending ? 'Removing…' : 'Remove'}
        </button>
      )}
      {removeError && <span className="text-xs text-red-600">{removeError}</span>}
    </div>
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
