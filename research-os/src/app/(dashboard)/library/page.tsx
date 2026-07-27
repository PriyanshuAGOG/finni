import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { listSources } from '../../../services/source';
import { ReviewStatusBadge, ProcessingStatusBadge, SourceTypeBadge } from '../../../components/badges';

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; review_status?: string }>;
}) {
  const ctx = await requireSessionContext();
  const resolvedSearchParams = await searchParams;
  const result = await listSources(ctx, {
    query: resolvedSearchParams.q || undefined,
    reviewStatus: resolvedSearchParams.review_status ? [resolvedSearchParams.review_status] : undefined,
    limit: 50,
    sort: 'created_at',
    order: 'desc',
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Library</h1>
          <p className="text-sm text-slate-500">{result.items.length} source(s) shown.</p>
        </div>
      </div>

      <form className="card flex flex-wrap items-end gap-3 p-4">
        <div className="flex-1 min-w-[220px]">
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" defaultValue={resolvedSearchParams.q} className="input" placeholder="Title, publisher, author…" />
        </div>
        <div>
          <label className="label" htmlFor="review_status">Review status</label>
          <select id="review_status" name="review_status" defaultValue={resolvedSearchParams.review_status ?? ''} className="input">
            <option value="">All</option>
            <option value="needs_review">Needs review</option>
            <option value="in_review">In review</option>
            <option value="approved">Approved</option>
            <option value="approved_with_conditions">Approved (conditions)</option>
            <option value="rejected">Rejected</option>
            <option value="disputed">Disputed</option>
            <option value="superseded">Superseded</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary">Filter</button>
      </form>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Publisher</th>
              <th className="px-4 py-2">Review</th>
              <th className="px-4 py-2">Processing</th>
              <th className="px-4 py-2">Added</th>
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
                <td className="px-4 py-2"><SourceTypeBadge type={s.source_type} /></td>
                <td className="px-4 py-2 text-slate-500">{s.publisher ?? s.journal ?? '—'}</td>
                <td className="px-4 py-2"><ReviewStatusBadge status={s.review_status} /></td>
                <td className="px-4 py-2"><ProcessingStatusBadge status={s.processing_status} /></td>
                <td className="px-4 py-2 text-slate-500">{new Date(s.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {result.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  No sources match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
