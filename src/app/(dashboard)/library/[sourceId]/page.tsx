import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSessionContext } from '../../../lib/session';
import { getSource } from '../../../../services/source';
import { ApiError } from '../../../../lib/errors';
import { ProcessingStatusBadge, SourceTypeBadge } from '../../../../components/badges';
import { SourceActions } from './review-actions';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'reader', label: 'Read article' },
  { key: 'claims', label: 'Claims' },
  { key: 'study', label: 'Study data' },
  { key: 'annotations', label: 'Annotations' },
  { key: 'versions', label: 'Versions' },
  { key: 'activity', label: 'Activity' },
  { key: 'processing', label: 'Processing' },
];

export default async function SourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ sourceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const ctx = await requireSessionContext();
  const { sourceId } = await params;
  const resolvedSearchParams = await searchParams;
  const tab = TABS.some((t) => t.key === resolvedSearchParams.tab) ? resolvedSearchParams.tab! : 'overview';

  let source: Record<string, unknown>;
  try {
    source = await getSource(ctx, sourceId, {
      includeText: tab === 'reader',
      includeStudyMetadata: tab === 'study' || tab === 'overview',
      includeClaims: tab === 'claims' || tab === 'overview',
      includeAnnotations: tab === 'annotations',
      includeVersions: tab === 'versions',
      includeActivity: tab === 'activity',
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_FOUND') notFound();
    throw err;
  }

  const categories = (source.categories ?? []) as Array<{ id: string; name: string; approved: boolean }>;
  const tags = (source.tags ?? []) as Array<{ id: string; name: string }>;
  const collections = (source.collections ?? []) as Array<{ id: string; name: string }>;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/library" className="text-xs text-brand-600 hover:underline">
          ← Back to Library
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{String(source.title)}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <SourceTypeBadge type={String(source.source_type)} />
              <ProcessingStatusBadge status={String(source.processing_status)} />
              {source.publisher ? <span>{String(source.publisher)}</span> : null}
              {source.publication_date ? (
                <span>{new Date(String(source.publication_date)).getFullYear()}</span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {source.canonical_url ? (
              <a
                href={String(source.canonical_url)}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
              >
                Open original article ↗
              </a>
            ) : null}
            <Link href={`/library/${sourceId}?tab=reader`} className="btn btn-primary">
              Read in dashboard
            </Link>
            <SourceActions sourceId={sourceId} title={String(source.title)} />
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/library/${sourceId}?tab=${t.key}`}
            className={`border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? 'border-brand-600 font-medium text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab source={source} categories={categories} tags={tags} collections={collections} />}
      {tab === 'reader' && <ReaderTab source={source} />}
      {tab === 'claims' && <ClaimsTab source={source} />}
      {tab === 'study' && <StudyTab source={source} />}
      {tab === 'annotations' && <AnnotationsTab source={source} />}
      {tab === 'versions' && <VersionsTab source={source} />}
      {tab === 'activity' && <ActivityTab source={source} />}
      {tab === 'processing' && <ProcessingTab sourceId={sourceId} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}

function OverviewTab({
  source,
  categories,
  tags,
  collections,
}: {
  source: Record<string, unknown>;
  categories: Array<{ id: string; name: string; approved: boolean }>;
  tags: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
}) {
  const keyFindings = (source.key_findings ?? []) as string[];
  const limitations = (source.limitations ?? []) as string[];
  const safetyNotes = (source.safety_notes ?? []) as string[];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Section title="Summary">
          {source.human_summary ? (
            <p className="text-sm text-slate-700">{String(source.human_summary)}</p>
          ) : (
            <>
              <p className="text-sm text-slate-700">
                {String(source.ai_summary_detailed ?? source.ai_summary_short ?? 'No summary yet.')}
              </p>
              <p className="mt-2 text-xs text-amber-700">AI-generated summary — not yet reviewed by a human.</p>
            </>
          )}
        </Section>

        {keyFindings.length > 0 && (
          <Section title="Key findings">
            <ul className="list-inside list-disc space-y-1 text-sm text-slate-700">
              {keyFindings.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </Section>
        )}

        {limitations.length > 0 && (
          <Section title="Limitations">
            <ul className="list-inside list-disc space-y-1 text-sm text-slate-700">
              {limitations.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </Section>
        )}

        {safetyNotes.length > 0 && (
          <Section title="Safety notes">
            <ul className="list-inside list-disc space-y-1 text-sm text-red-700">
              {safetyNotes.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </Section>
        )}

        {source.evidence_summary ? (
          <Section title="Evidence assessment">
            <p className="text-sm text-slate-700">{String(source.evidence_summary)}</p>
          </Section>
        ) : null}
      </div>

      <div className="space-y-4">
        <Section title="Categories">
          <div className="flex flex-wrap gap-1">
            {categories.map((c) => (
              <span key={c.id} className={`badge ${c.approved ? 'badge-approved' : 'badge-unreviewed'}`}>
                {c.name}
              </span>
            ))}
            {categories.length === 0 && <span className="text-xs text-slate-400">None assigned.</span>}
          </div>
        </Section>
        <Section title="Tags">
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t.id} className="badge badge-neutral">{t.name}</span>
            ))}
            {tags.length === 0 && <span className="text-xs text-slate-400">None assigned.</span>}
          </div>
        </Section>
        <Section title="Collections">
          <ul className="space-y-1">
            {collections.map((c) => (
              <li key={c.id}>
                <Link href={`/collections/${c.id}`} className="text-sm text-brand-600 hover:underline">
                  {c.name}
                </Link>
              </li>
            ))}
            {collections.length === 0 && <span className="text-xs text-slate-400">Not in any collection.</span>}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function ReaderTab({ source }: { source: Record<string, unknown> }) {
  return (
    <Section title="Extracted text">
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-sm text-slate-700">
        {String(source.text ?? 'No text available.')}
      </pre>
      {source.text_truncated ? (
        <p className="mt-2 text-xs text-slate-400">
          Text truncated for display ({String(source.text_total_length)} characters total).
        </p>
      ) : null}
    </Section>
  );
}

function ClaimsTab({ source }: { source: Record<string, unknown> }) {
  const claims = (source.claims ?? []) as Array<{
    id: string;
    canonical_text: string;
    evidence_status: string;
    relationship: string;
  }>;
  return (
    <Section title="Claims evidenced by this source">
      <ul className="divide-y divide-slate-100">
        {claims.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2">
            <Link href={`/claims/${c.id}`} className="text-sm text-slate-800 hover:text-brand-600">
              {c.canonical_text}
            </Link>
            <span className="badge badge-neutral">{c.relationship}</span>
          </li>
        ))}
        {claims.length === 0 && <li className="py-4 text-sm text-slate-400">No claims linked yet.</li>}
      </ul>
    </Section>
  );
}

function StudyTab({ source }: { source: Record<string, unknown> }) {
  const study = source.study_metadata as Record<string, unknown> | null;
  if (!study) {
    return (
      <Section title="Study data">
        <p className="text-sm text-slate-400">No study metadata was extracted for this source.</p>
      </Section>
    );
  }
  const fields: Array<[string, unknown]> = [
    ['Study design', study.study_design],
    ['Sample size', study.sample_size],
    ['Population', study.population_description],
    ['Intervention', study.intervention],
    ['Comparator', study.comparator],
    ['Duration', study.duration],
    ['Primary outcomes', study.primary_outcomes],
    ['Funding source', study.funding_source],
    ['Conflicts of interest', study.conflicts_of_interest],
  ];
  return (
    <Section title="Study data">
      {!study.human_verified && (
        <p className="mb-3 text-xs text-amber-700">Extracted automatically — not yet human-verified.</p>
      )}
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt className="label">{label}</dt>
            <dd className="text-sm text-slate-700">
              {value == null || (Array.isArray(value) && value.length === 0)
                ? '—'
                : Array.isArray(value)
                  ? value.join(', ')
                  : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function AnnotationsTab({ source }: { source: Record<string, unknown> }) {
  const annotations = (source.annotations ?? []) as Array<{
    id: string;
    annotation_type: string;
    body: string | null;
    author_name: string;
    created_at: string;
    status: string;
  }>;
  return (
    <Section title="Annotations">
      <ul className="space-y-3">
        {annotations.map((a) => (
          <li key={a.id} className="border-l-2 border-slate-200 pl-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="badge badge-neutral">{a.annotation_type.replace(/_/g, ' ')}</span>
              <span>{a.author_name}</span>
              <span>{new Date(a.created_at).toLocaleDateString()}</span>
              {a.status === 'resolved' && <span className="badge badge-approved">Resolved</span>}
            </div>
            <p className="mt-1 text-sm text-slate-700">{a.body}</p>
          </li>
        ))}
        {annotations.length === 0 && <li className="text-sm text-slate-400">No annotations yet.</li>}
      </ul>
    </Section>
  );
}

function VersionsTab({ source }: { source: Record<string, unknown> }) {
  const versions = (source.versions ?? []) as Array<{
    id: string;
    version_number: number;
    captured_at: string;
    change_summary: string | null;
  }>;
  return (
    <Section title="Versions">
      <ul className="divide-y divide-slate-100">
        {versions.map((v) => (
          <li key={v.id} className="py-2 text-sm">
            <span className="font-medium">v{v.version_number}</span>{' '}
            <span className="text-slate-500">{new Date(v.captured_at).toLocaleString()}</span>
            {v.change_summary && <div className="text-xs text-slate-500">{v.change_summary}</div>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ActivityTab({ source }: { source: Record<string, unknown> }) {
  const activity = (source.activity ?? []) as Array<{
    id: string;
    action: string;
    actor_name: string | null;
    actor_type: string;
    source_interface: string;
    created_at: string;
  }>;
  return (
    <Section title="Activity">
      <ul className="space-y-2">
        {activity.map((a) => (
          <li key={a.id} className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">{a.actor_name ?? a.actor_type}</span>{' '}
            {a.action.replace(/_/g, ' ')}
            <span className="ml-2 text-xs text-slate-400">
              via {a.source_interface} · {new Date(a.created_at).toLocaleString()}
            </span>
          </li>
        ))}
        {activity.length === 0 && <li className="text-sm text-slate-400">No activity recorded.</li>}
      </ul>
    </Section>
  );
}

async function ProcessingTab({ sourceId }: { sourceId: string }) {
  const ctx = await requireSessionContext();
  const { listProcessingJobs } = await import('../../../../services/processing');
  const jobs = await listProcessingJobs(ctx, { sourceId, limit: 50 });

  return (
    <Section title="Processing pipeline">
      <ul className="divide-y divide-slate-100">
        {jobs.map((j) => (
          <li key={String(j.id)} className="flex items-center justify-between py-2 text-sm">
            <div>
              <span className="font-medium">{String(j.job_type)}</span>
              {j.error_message ? (
                <div className="text-xs text-red-600">{String(j.error_message)}</div>
              ) : null}
            </div>
            <ProcessingStatusBadge status={String(j.status)} />
          </li>
        ))}
        {jobs.length === 0 && <li className="py-4 text-sm text-slate-400">No processing jobs recorded.</li>}
      </ul>
    </Section>
  );
}
