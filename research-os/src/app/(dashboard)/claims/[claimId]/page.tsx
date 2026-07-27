import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSessionContext } from '../../../lib/session';
import { getClaim } from '../../../../services/claim';
import { ApiError } from '../../../../lib/errors';
import { EvidenceStatusBadge, ReviewStatusBadge } from '../../../../components/badges';

function EvidenceList({
  title,
  items,
}: {
  title: string;
  items: Array<{ source_id: string; title: string; excerpt: string | null; review_status: string; locator: string | null }>;
}) {
  return (
    <div className="card p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-900">{title} ({items.length})</h2>
      <ul className="space-y-3">
        {items.map((e) => (
          <li key={`${e.source_id}-${e.locator}`} className="border-l-2 border-slate-200 pl-3">
            <Link href={`/library/${e.source_id}`} className="text-sm font-medium text-slate-800 hover:text-brand-600">
              {e.title}
            </Link>
            <ReviewStatusBadge status={e.review_status} />
            {e.excerpt && <p className="mt-1 text-xs text-slate-600">"{e.excerpt.slice(0, 240)}"</p>}
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-slate-400">None.</li>}
      </ul>
    </div>
  );
}

export default async function ClaimDetailPage({ params }: { params: Promise<{ claimId: string }> }) {
  const ctx = await requireSessionContext();
  const { claimId } = await params;

  let claim: Record<string, unknown>;
  try {
    claim = await getClaim(ctx, claimId);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_FOUND') notFound();
    throw err;
  }

  return (
    <div className="space-y-4">
      <Link href="/claims" className="text-xs text-brand-600 hover:underline">
        ← Back to Claims
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-slate-900">{String(claim.canonical_text)}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          <EvidenceStatusBadge status={String(claim.evidence_status)} />
          <span className="badge badge-neutral">{String(claim.clinical_review_status).replace(/_/g, ' ')}</span>
          {claim.safety_relevance !== 'none' && (
            <span className="badge badge-rejected">Safety relevant</span>
          )}
        </div>
        {Boolean(claim.human_notes) && (
          <p className="mt-3 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700">
            {String(claim.human_notes)}
          </p>
        )}
      </div>

      <dl className="card grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
        {(['population', 'intervention', 'comparator', 'outcome', 'timeframe', 'context'] as const).map((field) => (
          <div key={field}>
            <dt className="label">{field}</dt>
            <dd className="text-sm text-slate-700">{(claim[field] as string) ?? '—'}</dd>
          </div>
        ))}
      </dl>

      <EvidenceList title="Supporting evidence" items={claim.supporting_evidence as never} />
      <EvidenceList title="Contradicting evidence" items={claim.contradicting_evidence as never} />
      <EvidenceList title="Qualifying evidence" items={claim.qualifying_evidence as never} />
    </div>
  );
}
