import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSessionContext } from '../../../lib/session';
import { getBrief } from '../../../../services/brief';
import { ApiError } from '../../../../lib/errors';

function Section({ heading, body }: { heading: string; body: unknown }) {
  if (!body) return null;
  return (
    <div className="card p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-900">{heading}</h2>
      <p className="whitespace-pre-wrap text-sm text-slate-700">{String(body)}</p>
    </div>
  );
}

export default async function BriefDetailPage({ params }: { params: Promise<{ briefId: string }> }) {
  const ctx = await requireSessionContext();
  const { briefId } = await params;

  let brief: Record<string, unknown>;
  try {
    brief = await getBrief(ctx, briefId);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_FOUND') notFound();
    throw err;
  }

  const sources = (brief.sources ?? []) as Array<{ id: string; title: string; review_status: string }>;

  return (
    <div className="space-y-4">
      <Link href="/briefs" className="text-xs text-brand-600 hover:underline">
        ← Back to Briefs
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-slate-900">{String(brief.title)}</h1>
        <div className="mt-1 flex gap-2 text-xs">
          <span className="badge badge-neutral">{String(brief.brief_type).replace(/_/g, ' ')}</span>
          <span className="badge badge-neutral">{String(brief.status)}</span>
          {brief.approved_only ? (
            <span className="badge badge-approved">Approved sources only</span>
          ) : (
            <span className="badge badge-unreviewed">
              Includes {String(brief.unreviewed_source_count)} unreviewed source(s)
            </span>
          )}
        </div>
      </div>

      <Section heading="Executive summary" body={brief.executive_summary} />
      <Section heading="Methodology" body={brief.methodology} />
      <Section heading="Findings" body={brief.findings} />
      <Section heading="Conflicting evidence" body={brief.conflicting_evidence} />
      <Section heading="Limitations" body={brief.limitations} />
      <Section heading="Recommendations" body={brief.recommendations} />
      <Section heading="Safety notes" body={brief.safety_notes} />

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Sources ({sources.length})</h2>
        <ol className="list-inside list-decimal space-y-1 text-sm">
          {sources.map((s) => (
            <li key={s.id}>
              <Link href={`/library/${s.id}`} className="text-brand-600 hover:underline">
                {s.title}
              </Link>{' '}
              <span className="text-xs text-slate-400">({s.review_status})</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
