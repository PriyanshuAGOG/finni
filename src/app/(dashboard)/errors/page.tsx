import { requireSessionContext } from '../../lib/session';
import { errorLogCounts, listErrorLogs } from '../../../services/errors';
import { isApiError } from '../../../lib/errors';
import { resolveErrorLogAction } from '../../actions/errors';

const SEVERITY_BADGE: Record<string, string> = {
  fatal: 'badge-rejected',
  error: 'badge-rejected',
  warning: 'badge-unreviewed',
};

export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const ctx = await requireSessionContext();
  const { show } = await searchParams;
  const showResolved = show === 'all';

  let items: Awaited<ReturnType<typeof listErrorLogs>>['items'] = [];
  let counts = { unresolved: 0, last_24h: 0 };
  let forbidden = false;

  try {
    const result = await Promise.all([
      listErrorLogs(ctx, { limit: 50, resolved: showResolved ? undefined : false }),
      errorLogCounts(ctx),
    ]);
    items = result[0].items;
    counts = result[1];
  } catch (err) {
    if (isApiError(err) && err.code === 'FORBIDDEN') {
      forbidden = true;
    } else {
      throw err;
    }
  }

  if (forbidden) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-slate-900">Errors</h1>
        <div className="card p-6 text-sm text-slate-600">
          You need the audit.read permission to view the error log. Ask an administrator to grant it.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Errors</h1>
          <p className="text-sm text-slate-500">
            Every server fault (5xx) and every dashboard crash, caught automatically with where and why.
          </p>
        </div>
        <div className="flex gap-4 text-right text-sm">
          <div>
            <div className="text-lg font-semibold text-slate-900">{counts.unresolved}</div>
            <div className="text-slate-500">Unresolved</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-slate-900">{counts.last_24h}</div>
            <div className="text-slate-500">Last 24h</div>
          </div>
        </div>
      </div>

      <div className="flex gap-2 text-sm">
        <a href="/errors" className={`btn ${!showResolved ? 'btn-primary' : 'btn-secondary'}`}>
          Unresolved
        </a>
        <a href="/errors?show=all" className={`btn ${showResolved ? 'btn-primary' : 'btn-secondary'}`}>
          All
        </a>
      </div>

      <div className="space-y-3">
        {items.map((item) => (
          <details key={item.id} className="card overflow-hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`badge ${SEVERITY_BADGE[item.severity] ?? 'badge-neutral'}`}>
                  {item.severity}
                </span>
                <span className="badge badge-neutral">{item.origin}</span>
                {item.status_code && <span className="badge badge-neutral">{item.status_code}</span>}
                <span className="truncate text-sm text-slate-800">{item.message}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs text-slate-400">
                {item.resolved && <span className="badge badge-approved">resolved</span>}
                <span>{new Date(item.created_at).toLocaleString()}</span>
              </div>
            </summary>

            <div className="border-t border-slate-100 px-4 py-3 text-sm">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-500 sm:grid-cols-4">
                {item.operation_id && (
                  <div>
                    <dt className="font-medium text-slate-400">Operation</dt>
                    <dd className="text-slate-700">{item.operation_id}</dd>
                  </div>
                )}
                {item.path && (
                  <div>
                    <dt className="font-medium text-slate-400">Path</dt>
                    <dd className="text-slate-700">
                      {item.method} {item.path}
                    </dd>
                  </div>
                )}
                {item.error_code && (
                  <div>
                    <dt className="font-medium text-slate-400">Error code</dt>
                    <dd className="text-slate-700">{item.error_code}</dd>
                  </div>
                )}
                {item.request_id && (
                  <div>
                    <dt className="font-medium text-slate-400">Request id</dt>
                    <dd className="font-mono text-slate-700">{item.request_id}</dd>
                  </div>
                )}
                {item.url && (
                  <div className="col-span-2">
                    <dt className="font-medium text-slate-400">Page</dt>
                    <dd className="truncate text-slate-700">{item.url}</dd>
                  </div>
                )}
              </dl>

              {item.stack && (
                <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
                  {item.stack}
                </pre>
              )}

              {item.resolution_note && (
                <p className="mt-3 text-xs text-slate-500">
                  Resolution note: <span className="text-slate-700">{item.resolution_note}</span>
                </p>
              )}

              {!item.resolved && (
                <form action={resolveErrorLogAction} className="mt-3 flex items-center gap-2">
                  <input type="hidden" name="id" value={item.id} />
                  <input
                    type="text"
                    name="note"
                    placeholder="Optional note on the fix"
                    className="input max-w-sm"
                  />
                  <button type="submit" className="btn btn-secondary shrink-0">
                    Mark resolved
                  </button>
                </form>
              )}
            </div>
          </details>
        ))}

        {items.length === 0 && (
          <div className="card p-8 text-center text-slate-400">
            {showResolved ? 'No errors recorded yet.' : 'No unresolved errors. Nice.'}
          </div>
        )}
      </div>
    </div>
  );
}
