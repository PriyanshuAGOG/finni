import Link from 'next/link';
import { requireSessionContext } from '../lib/session';
import { withOrg } from '../../lib/db';
import { ReviewStatusBadge } from '../../components/badges';

async function loadHomeStats(organizationId: string) {
  return withOrg(organizationId, async (sql) => {
    const [counts, recentSources, recentActivity, failedJobs, staleAssignments] = await Promise.all([
      sql.one<Record<string, number>>(
        `SELECT
           count(*) FILTER (WHERE status = 'active')::int AS active_sources,
           count(*) FILTER (WHERE status = 'active' AND review_status IN ('approved','approved_with_conditions'))::int AS approved_sources,
           count(*) FILTER (WHERE status = 'active' AND review_status IN ('needs_review','in_review','unreviewed'))::int AS awaiting_review,
           count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS added_this_week,
           count(*) FILTER (WHERE updated_at > now() - interval '7 days')::int AS updated_this_week,
           count(*) FILTER (WHERE retraction_status != 'none')::int AS retraction_warnings,
           count(*) FILTER (WHERE duplicate_status NOT IN ('none','resolved_keep_both','resolved_merged'))::int AS duplicate_warnings
         FROM sources`,
      ),
      sql.query<{ id: string; title: string; review_status: string; created_at: string }>(
        `SELECT id, title, review_status::text, created_at FROM sources
         WHERE status = 'active' ORDER BY created_at DESC LIMIT 6`,
      ),
      sql.query<{ id: string; action: string; created_at: string; actor_name: string | null; resource_type: string }>(
        `SELECT a.id, a.action, a.created_at, u.full_name AS actor_name, a.resource_type
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY a.created_at DESC LIMIT 8`,
      ),
      sql.query<{ id: string; job_type: string; error_message: string | null; source_id: string | null }>(
        `SELECT id, job_type, error_message, source_id FROM processing_jobs
         WHERE status IN ('failed','dead_letter') ORDER BY updated_at DESC LIMIT 5`,
      ),
      sql.query<{ id: string; title: string }>(
        `SELECT id, title FROM sources
         WHERE status = 'active' AND review_status IN ('needs_review','in_review')
           AND updated_at < now() - interval '5 days'
         ORDER BY updated_at ASC LIMIT 5`,
      ),
    ]);
    return { counts: counts ?? {}, recentSources, recentActivity, failedJobs, staleAssignments };
  });
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'danger' }) {
  const toneClass =
    tone === 'danger' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-900';
  return (
    <div className="card p-4">
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default async function HomePage() {
  const ctx = await requireSessionContext();
  const data = await loadHomeStats(ctx.organizationId);
  const c = data.counts;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Home</h1>
        <p className="text-sm text-slate-500">An overview of the research library and recent activity.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Active sources" value={c.active_sources ?? 0} />
        <StatTile label="Approved" value={c.approved_sources ?? 0} />
        <StatTile label="Awaiting review" value={c.awaiting_review ?? 0} tone="warn" />
        <StatTile label="Added this week" value={c.added_this_week ?? 0} />
        <StatTile label="Retraction warnings" value={c.retraction_warnings ?? 0} tone="danger" />
        <StatTile label="Duplicate warnings" value={c.duplicate_warnings ?? 0} tone="warn" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Recently added sources</h2>
            <Link href="/library" className="text-xs text-brand-600 hover:underline">
              View library →
            </Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {data.recentSources.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <Link href={`/library/${s.id}`} className="truncate text-sm text-slate-800 hover:text-brand-600">
                  {s.title}
                </Link>
                <ReviewStatusBadge status={s.review_status} />
              </li>
            ))}
            {data.recentSources.length === 0 && (
              <li className="py-4 text-sm text-slate-400">No sources yet. Add one from the Library.</li>
            )}
          </ul>
        </div>

        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Recent activity</h2>
            <Link href="/activity" className="text-xs text-brand-600 hover:underline">
              View all →
            </Link>
          </div>
          <ul className="space-y-2">
            {data.recentActivity.map((a) => (
              <li key={a.id} className="text-sm text-slate-600">
                <span className="font-medium text-slate-800">{a.actor_name ?? 'System'}</span>{' '}
                {a.action.replace(/_/g, ' ')}
                <span className="ml-2 text-xs text-slate-400">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
            {data.recentActivity.length === 0 && (
              <li className="py-4 text-sm text-slate-400">No activity yet.</li>
            )}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Failed processing jobs</h2>
          <ul className="space-y-2">
            {data.failedJobs.map((j) => (
              <li key={j.id} className="text-sm">
                <span className="font-medium text-red-600">{j.job_type}</span>
                {j.source_id && (
                  <Link href={`/library/${j.source_id}`} className="ml-2 text-brand-600 hover:underline">
                    view source
                  </Link>
                )}
                <div className="text-xs text-slate-500">{j.error_message}</div>
              </li>
            ))}
            {data.failedJobs.length === 0 && <li className="text-sm text-slate-400">No failures.</li>}
          </ul>
        </div>

        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Stale review assignments</h2>
          <ul className="space-y-2">
            {data.staleAssignments.map((s) => (
              <li key={s.id}>
                <Link href={`/library/${s.id}`} className="text-sm text-slate-700 hover:text-brand-600">
                  {s.title}
                </Link>
              </li>
            ))}
            {data.staleAssignments.length === 0 && (
              <li className="text-sm text-slate-400">Nothing has been waiting long.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
