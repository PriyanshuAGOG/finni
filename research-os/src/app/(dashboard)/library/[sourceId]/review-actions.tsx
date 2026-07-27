'use client';

import { useState, useTransition } from 'react';
import { approveSourceAction, rejectSourceAction, archiveSourceWithConfirmationAction } from './actions';

export function ReviewActions({ sourceId, reviewStatus }: { sourceId: string; reviewStatus: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');

  const canApprove = !['approved', 'approved_with_conditions'].includes(reviewStatus);
  const canReject = reviewStatus !== 'rejected';

  const run = (action: () => Promise<{ error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {canApprove && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => approveSourceAction(sourceId))}
            className="btn btn-primary"
          >
            Approve
          </button>
        )}
        {canReject && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setShowReject((s) => !s)}
            className="btn btn-secondary"
          >
            Reject
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => archiveSourceWithConfirmationAction(sourceId, 'this source'))}
          className="btn btn-secondary"
        >
          Archive
        </button>
      </div>

      {showReject && (
        <div className="flex items-center gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for rejection"
            className="input w-64"
          />
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => run(() => rejectSourceAction(sourceId, reason))}
            className="btn btn-secondary"
          >
            Confirm reject
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
