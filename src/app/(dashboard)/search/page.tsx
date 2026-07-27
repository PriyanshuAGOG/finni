import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { searchKnowledge } from '../../../services/search';
import { synthesizeKnowledge } from '../../../services/synthesis';
import { ReviewStatusBadge } from '../../../components/badges';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; mode?: string; answer?: string }>;
}) {
  const ctx = await requireSessionContext();
  const resolvedSearchParams = await searchParams;
  const query = resolvedSearchParams.q?.trim();
  const mode = (resolvedSearchParams.mode as 'library_only' | 'library_first' | undefined) ?? 'library_first';
  const wantsAnswer = resolvedSearchParams.answer === '1';

  const [results, synthesis] = query
    ? await Promise.all([
        searchKnowledge(ctx, {
          query,
          mode,
          includePassages: true,
          includeUnreviewed: mode !== 'library_only',
          limit: 15,
        }),
        wantsAnswer
          ? synthesizeKnowledge(ctx, { question: query, approvedOnly: mode === 'library_only' })
          : Promise.resolve(null),
      ])
    : [null, null];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Search &amp; Research Assistant</h1>
        <p className="text-sm text-slate-500">
          Mode: <span className="font-medium">{mode.replace(/_/g, ' ')}</span> — always shown so it's clear what
          scope an answer came from.
        </p>
      </div>

      <form className="card flex flex-wrap items-end gap-3 p-4">
        <div className="flex-1 min-w-[260px]">
          <label className="label" htmlFor="q">Question or search terms</label>
          <input id="q" name="q" defaultValue={query} className="input" placeholder="What evidence do we have on…" />
        </div>
        <div>
          <label className="label" htmlFor="mode">Mode</label>
          <select id="mode" name="mode" defaultValue={mode} className="input">
            <option value="library_only">Library only (approved)</option>
            <option value="library_first">Library first</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" name="answer" value="1" defaultChecked={wantsAnswer} />
          Generate cited answer
        </label>
        <button type="submit" className="btn btn-primary">Search</button>
      </form>

      {synthesis && (
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">
            Answer <span className="badge badge-neutral ml-2">{synthesis.scope.source_origin}</span>
          </h2>
          <p className="whitespace-pre-wrap text-sm text-slate-700">{synthesis.answer}</p>
          {synthesis.limitations.length > 0 && (
            <div className="mt-3 text-xs text-slate-500">
              <strong>Limitations:</strong> {synthesis.limitations.join(' ')}
            </div>
          )}
          {synthesis.citations.length > 0 && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Sources</h3>
              <ol className="space-y-1 text-xs text-slate-600">
                {synthesis.citations.map((c) => (
                  <li key={c.marker}>
                    {c.marker}{' '}
                    <Link href={c.dashboard_url} className="text-brand-600 hover:underline">
                      {c.title}
                    </Link>{' '}
                    ({c.review_status})
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {results && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            {results.results.length} result(s) — {results.scope.approved_count} approved,{' '}
            {results.scope.unreviewed_count} unreviewed.
          </p>
          {results.results.map((r) => (
            <div key={`${r.entity_type}-${r.id}`} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Link href={r.dashboard_url} className="text-sm font-medium text-slate-900 hover:text-brand-600">
                    {r.title}
                  </Link>
                  <p className="mt-1 text-xs text-slate-500">{r.relevance_reason}</p>
                </div>
                {r.review_status && <ReviewStatusBadge status={r.review_status} />}
              </div>
              {r.matched_passages.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                  {r.matched_passages.slice(0, 2).map((p) => (
                    <p key={p.passage_id} className="text-xs text-slate-600">
                      "{p.text.slice(0, 220)}{p.text.length > 220 ? '…' : ''}"{' '}
                      <span className="text-slate-400">({p.locator})</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
          {results.results.length === 0 && (
            <div className="card p-6 text-center text-sm text-slate-400">No results. {results.gaps[0]}</div>
          )}
        </div>
      )}
    </div>
  );
}
