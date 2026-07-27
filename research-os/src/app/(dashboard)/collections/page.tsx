import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { listCollections } from '../../../services/collection';

export default async function CollectionsPage() {
  const ctx = await requireSessionContext();
  const result = await listCollections(ctx, { limit: 50 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Collections</h1>
        <p className="text-sm text-slate-500">{result.items.length} collection(s).</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {result.items.map((c) => (
          <Link key={c.id} href={`/collections/${c.id}`} className="card block p-4 hover:border-brand-300">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold text-slate-900">{c.name}</h2>
              <span className="badge badge-neutral">{c.collection_type.replace(/_/g, ' ')}</span>
            </div>
            {c.research_question && <p className="mt-1 text-xs text-slate-500">{c.research_question}</p>}
            <p className="mt-2 text-xs text-slate-400">{c.source_count ?? 0} source(s)</p>
          </Link>
        ))}
        {result.items.length === 0 && (
          <div className="card p-6 text-center text-sm text-slate-400">No collections yet.</div>
        )}
      </div>
    </div>
  );
}
