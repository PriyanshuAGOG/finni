import { requireSessionContext } from '../../lib/session';
import { withOrg } from '../../../lib/db';
import Link from 'next/link';

export default async function ContentStudioPage() {
  const ctx = await requireSessionContext();
  const items = await withOrg(ctx.organizationId, (sql) =>
    sql.query<{ id: string; title: string; content_type: string; status: string; created_at: string }>(
      `SELECT id, title, content_type, status, created_at FROM generated_content
       WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 50`,
    ),
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Content Studio</h1>
        <p className="text-sm text-slate-500">
          Evidence-backed drafts generated from library sources. Use the Custom GPT or the
          generateEvidenceBasedContent API to create a new draft.
        </p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link href={`/content/${i.id}`} className="text-slate-800 hover:text-brand-600">
                    {i.title}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-500">{i.content_type.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2"><span className="badge badge-neutral">{i.status}</span></td>
                <td className="px-4 py-2 text-slate-500">{new Date(i.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">No drafts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
