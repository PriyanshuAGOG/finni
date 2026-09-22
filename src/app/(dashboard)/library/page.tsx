import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { listSources } from '../../../services/source';
import { listCategories } from '../../../services/taxonomy';
import { ProcessingStatusBadge, SourceTypeBadge } from '../../../components/badges';

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category_id?: string }>;
}) {
  const ctx = await requireSessionContext();
  const resolvedSearchParams = await searchParams;
  const [result, topLevelCategories] = await Promise.all([
    listSources(ctx, {
      query: resolvedSearchParams.q || undefined,
      categoryId: resolvedSearchParams.category_id || undefined,
      limit: 50,
      sort: 'created_at',
      order: 'desc',
    }),
    listCategories(ctx, { parentId: null }),
  ]);

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
          <label className="label" htmlFor="category_id">Category</label>
          <select id="category_id" name="category_id" defaultValue={resolvedSearchParams.category_id ?? ''} className="input">
            <option value="">All</option>
            {topLevelCategories.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
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
              <th className="px-4 py-2">Category</th>
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
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {s.categories.map((c) => (
                      <span key={c.id} className="badge badge-neutral">{c.name}</span>
                    ))}
                    {s.categories.length === 0 && <span className="text-xs text-slate-400">Uncategorized</span>}
                  </div>
                </td>
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
