import { requireSessionContext } from '../../lib/session';
import { listAuditEvents } from '../../../services/audit';

export default async function ActivityPage() {
  const ctx = await requireSessionContext();
  const result = await listAuditEvents(ctx, { limit: 100 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Activity</h1>
        <p className="text-sm text-slate-500">
          Every write, from every interface, with who did it and how.
        </p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Summary</th>
              <th className="px-4 py-2">Interface</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.items.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50">
                <td className="px-4 py-2 text-slate-700">{a.summary}</td>
                <td className="px-4 py-2">
                  <span className="badge badge-neutral">{a.source_interface}</span>
                </td>
                <td className="px-4 py-2">
                  <span className={`badge ${a.status === 'success' ? 'badge-approved' : 'badge-rejected'}`}>
                    {a.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-slate-500">{new Date(a.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {result.items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">No activity yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
