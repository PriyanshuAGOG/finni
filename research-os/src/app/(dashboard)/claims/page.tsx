import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { searchClaims } from '../../../services/claim';
import { EvidenceStatusBadge } from '../../../components/badges';

export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ contradicted?: string }>;
}) {
  const ctx = await requireSessionContext();
  const resolvedSearchParams = await searchParams;
  const claims = await searchClaims(ctx, {
    contradictedOnly: resolvedSearchParams.contradicted === '1',
    limit: 100,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Claims &amp; Evidence</h1>
          <p className="text-sm text-slate-500">{claims.length} claim(s).</p>
        </div>
        <Link
          href={resolvedSearchParams.contradicted === '1' ? '/claims' : '/claims?contradicted=1'}
          className="btn btn-secondary"
        >
          {resolvedSearchParams.contradicted === '1' ? 'Show all' : 'Show contradicted only'}
        </Link>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Claim</th>
              <th className="px-4 py-2">Evidence status</th>
              <th className="px-4 py-2">Supporting</th>
              <th className="px-4 py-2">Contradicting</th>
              <th className="px-4 py-2">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {claims.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="max-w-lg px-4 py-2">
                  <Link href={`/claims/${c.id}`} className="text-slate-800 hover:text-brand-600">
                    {c.canonical_text}
                  </Link>
                </td>
                <td className="px-4 py-2"><EvidenceStatusBadge status={c.evidence_status} /></td>
                <td className="px-4 py-2 text-slate-500">{c.supporting_count}</td>
                <td className="px-4 py-2 text-slate-500">{c.contradicting_count}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{c.clinical_review_status.replace(/_/g, ' ')}</td>
              </tr>
            ))}
            {claims.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No claims match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
