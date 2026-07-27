const REVIEW_LABELS: Record<string, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'badge-approved' },
  approved_with_conditions: { label: 'Approved (conditions)', className: 'badge-approved' },
  unreviewed: { label: 'Unreviewed', className: 'badge-unreviewed' },
  needs_review: { label: 'Needs review', className: 'badge-unreviewed' },
  in_review: { label: 'In review', className: 'badge-unreviewed' },
  rejected: { label: 'Rejected', className: 'badge-rejected' },
  disputed: { label: 'Disputed', className: 'badge-rejected' },
  superseded: { label: 'Superseded', className: 'badge-neutral' },
};

export function ReviewStatusBadge({ status }: { status: string }) {
  const info = REVIEW_LABELS[status] ?? { label: status, className: 'badge-neutral' };
  return <span className={`badge ${info.className}`}>{info.label}</span>;
}

const PROCESSING_LABELS: Record<string, string> = {
  queued: 'Queued',
  fetching: 'Fetching',
  extracting: 'Extracting',
  classifying: 'Classifying',
  embedding: 'Embedding',
  enriching: 'Enriching',
  completed: 'Completed',
  completed_with_warnings: 'Completed (warnings)',
  failed: 'Failed',
  requires_manual_input: 'Needs manual input',
};

export function ProcessingStatusBadge({ status }: { status: string }) {
  const label = PROCESSING_LABELS[status] ?? status;
  const className =
    status === 'completed'
      ? 'badge-approved'
      : status === 'failed'
        ? 'badge-rejected'
        : status === 'completed_with_warnings'
          ? 'badge-unreviewed'
          : 'badge-neutral';
  return <span className={`badge ${className}`}>{label}</span>;
}

export function SourceTypeBadge({ type }: { type: string }) {
  return <span className="badge badge-neutral">{type.replace(/_/g, ' ')}</span>;
}

export function EvidenceStatusBadge({ status }: { status: string }) {
  const className =
    status === 'supported' || status === 'likely_supported'
      ? 'badge-approved'
      : status === 'contradicted' || status === 'contested'
        ? 'badge-rejected'
        : 'badge-unreviewed';
  return <span className={`badge ${className}`}>{status.replace(/_/g, ' ')}</span>;
}
