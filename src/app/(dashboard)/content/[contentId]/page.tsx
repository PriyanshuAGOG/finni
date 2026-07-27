import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSessionContext } from '../../../lib/session';
import { getGeneratedContent } from '../../../../services/content';
import { ApiError } from '../../../../lib/errors';

export default async function ContentDetailPage({ params }: { params: Promise<{ contentId: string }> }) {
  const ctx = await requireSessionContext();
  const { contentId } = await params;
  let content: Record<string, unknown>;
  try {
    content = await getGeneratedContent(ctx, contentId);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_FOUND') notFound();
    throw err;
  }

  const citations = (content.citations ?? []) as Array<{
    citation_marker: string;
    title: string;
    source_id: string;
    review_status: string;
  }>;
  const safetyFlags = (content.safety_flags ?? []) as string[];
  const unsupported = (content.unsupported_claims ?? []) as string[];

  return (
    <div className="space-y-4">
      <Link href="/content" className="text-xs text-brand-600 hover:underline">
        ← Back to Content Studio
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-slate-900">{String(content.title)}</h1>
        <span className="badge badge-neutral">{String(content.status)}</span>
      </div>

      {safetyFlags.length > 0 && (
        <div className="card border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-1 text-sm font-semibold text-amber-800">Safety flags</h2>
          <ul className="list-inside list-disc text-sm text-amber-800">
            {safetyFlags.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}

      {unsupported.length > 0 && (
        <div className="card border-red-200 bg-red-50 p-4">
          <h2 className="mb-1 text-sm font-semibold text-red-800">Unsupported statements</h2>
          <ul className="list-inside list-disc text-sm text-red-800">
            {unsupported.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}

      <div className="card p-4">
        <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-slate-700">
          {String(content.body)}
        </div>
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Citations</h2>
        <ul className="space-y-1 text-sm">
          {citations.map((c) => (
            <li key={c.citation_marker}>
              {c.citation_marker}{' '}
              <Link href={`/library/${c.source_id}`} className="text-brand-600 hover:underline">
                {c.title}
              </Link>{' '}
              <span className="text-xs text-slate-400">({c.review_status})</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
