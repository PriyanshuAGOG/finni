import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { listBriefs } from '../../../services/brief';

export default async function BriefsPage() {
  const ctx = await requireSessionContext();
  const briefs = await listBriefs(ctx, { limit: 50 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Research Briefs</h1>
        <p className="text-sm text-slate-500">{briefs.length} brief(s).</p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {briefs.map((b) => (
              <tr key={b.id} className="hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link href={`/briefs/${b.id}`} className="text-slate-800 hover:text-brand-600">
                    {b.title}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-500">{b.brief_type.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2"><span className="badge badge-neutral">{b.status}</span></td>
                <td className="px-4 py-2 text-slate-500">{new Date(b.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {briefs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">No briefs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
