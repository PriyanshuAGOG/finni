import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSessionContext } from '../../../lib/session';
import { getCollection } from '../../../../services/collection';
import { ApiError } from '../../../../lib/errors';
import { ReviewStatusBadge } from '../../../../components/badges';

export default async function CollectionDetailPage({ params }: { params: Promise<{ collectionId: string }> }) {
  const ctx = await requireSessionContext();
  const { collectionId } = await params;

  let collection: Record<string, unknown>;
  try {
    collection = await getCollection(ctx, collectionId, {
      includeSources: true,
      includeClaims: true,
      includeBriefs: true,
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_FOUND') notFound();
    throw err;
  }

  const sources = (collection.sources ?? []) as Array<{
    id: string;
    title: string;
    review_status: string;
    source_type: string;
  }>;
  const claims = (collection.claims ?? []) as Array<{ id: string; canonical_text: string; evidence_status: string }>;
  const briefs = (collection.briefs ?? []) as Array<{ id: string; title: string; status: string }>;
  const breakdown = (collection.review_status_breakdown ?? {}) as Record<string, number>;

  return (
    <div className="space-y-4">
      <Link href="/collections" className="text-xs text-brand-600 hover:underline">
        ← Back to Collections
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-slate-900">{String(collection.name)}</h1>
        {Boolean(collection.research_question) && (
          <p className="mt-1 text-sm text-slate-600">{String(collection.research_question)}</p>
        )}
        <div className="mt-2 flex gap-2 text-xs text-slate-500">
          {Object.entries(breakdown).map(([status, count]) => (
            <span key={status} className="badge badge-neutral">
              {count} {status.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Sources</h2>
        <ul className="divide-y divide-slate-100">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <Link href={`/library/${s.id}`} className="text-sm text-slate-800 hover:text-brand-600">
                {s.title}
              </Link>
              <ReviewStatusBadge status={s.review_status} />
            </li>
          ))}
          {sources.length === 0 && <li className="py-4 text-sm text-slate-400">No sources yet.</li>}
        </ul>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Related claims</h2>
          <ul className="space-y-1">
            {claims.map((c) => (
              <li key={c.id}>
                <Link href={`/claims/${c.id}`} className="text-sm text-slate-700 hover:text-brand-600">
                  {c.canonical_text}
                </Link>
              </li>
            ))}
            {claims.length === 0 && <li className="text-sm text-slate-400">No claims yet.</li>}
          </ul>
        </div>
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Briefs</h2>
          <ul className="space-y-1">
            {briefs.map((b) => (
              <li key={b.id}>
                <Link href={`/briefs/${b.id}`} className="text-sm text-slate-700 hover:text-brand-600">
                  {b.title}
                </Link>
              </li>
            ))}
            {briefs.length === 0 && <li className="text-sm text-slate-400">No briefs yet.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
