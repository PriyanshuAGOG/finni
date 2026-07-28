import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { listSources } from '../../../services/source';
import { ReviewStatusBadge, ProcessingStatusBadge } from '../../../components/badges';
import { AddSourceForm } from './add-source-form';

const VIEWS: Record<string, { reviewStatus?: string[]; processingStatus?: string[]; label: string }> = {
  all: { label: 'All' },
  processing: { processingStatus: ['queued', 'fetching', 'extracting', 'classifying', 'embedding', 'enriching'], label: 'Processing' },
  needs_review: { reviewStatus: ['needs_review', 'unreviewed'], label: 'Needs review' },
  in_review: { reviewStatus: ['in_review'], label: 'In review' },
  failed: { processingStatus: ['failed'], label: 'Failed' },
};

export default async function ResearchInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ctx = await requireSessionContext();
  const resolvedSearchParams = await searchParams;
  const view = VIEWS[resolvedSearchParams.view ?? 'needs_review']
    ? (resolvedSearchParams.view ?? 'needs_review')
    : 'needs_review';
  const spec = VIEWS[view];

  const result = await listSources(ctx, {
    reviewStatus: spec.reviewStatus,
    processingStatus: spec.processingStatus,
    limit: 50,
    sort: 'created_at',
    order: 'desc',
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Research Inbox</h1>
        <p className="text-sm text-slate-500">High-density triage of newly ingested and in-flight sources.</p>
      </div>

      <AddSourceForm />

      <div className="flex gap-2">
        {Object.entries(VIEWS).map(([key, v]) => (
          <Link
            key={key}
            href={`/inbox?view=${key}`}
            className={`btn ${view === key ? 'btn-primary' : 'btn-secondary'}`}
          >
            {v.label}
          </Link>
        ))}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Review</th>
              <th className="px-4 py-2">Processing</th>
              <th className="px-4 py-2">Reviewer</th>
              <th className="px-4 py-2">Duplicate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.items.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="max-w-md truncate px-4 py-2">
                  <Link href={`/library/${s.id}`} className="text-slate-800 hover:text-brand-600">
                    {s.title}
                  </Link>
                </td>
                <td className="px-4 py-2"><ReviewStatusBadge status={s.review_status} /></td>
                <td className="px-4 py-2"><ProcessingStatusBadge status={s.processing_status} /></td>
                <td className="px-4 py-2 text-slate-500">{s.assigned_reviewer_id ? 'Assigned' : '—'}</td>
                <td className="px-4 py-2 text-slate-500">
                  {s.duplicate_status !== 'none' ? (
                    <span className="badge badge-unreviewed">{s.duplicate_status.replace(/_/g, ' ')}</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {result.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  Nothing in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
