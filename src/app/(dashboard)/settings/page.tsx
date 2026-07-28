import { requireSessionContext } from '../../lib/session';
import { withOrg } from '../../../lib/db';
import { hasPermission } from '../../../lib/context';
import { listMembers, listPendingInvitations } from '../../../services/team';
import { InviteMemberForm, MemberRowActions, RevokeInvitationButton } from './team-controls';
import { CreateApiClientForm } from './integration-controls';

export default async function SettingsPage() {
  const ctx = await requireSessionContext();
  const canManageTeam = hasPermission(ctx, 'user.manage');
  const canManageIntegrations = hasPermission(ctx, 'integration.manage');

  const data = await withOrg(ctx.organizationId, async (sql) => {
    const org = await sql.one<{ name: string; settings: Record<string, unknown> }>(
      `SELECT name, settings FROM organizations WHERE id = $1`,
      [ctx.organizationId],
    );
    const apiClients = await sql.query<{ id: string; name: string; client_type: string; status: string; last_used_at: string | null }>(
      `SELECT id, name, client_type::text, status, last_used_at FROM api_clients ORDER BY created_at DESC`,
    );
    const roles = await sql.query<{ name: string; slug: string; permissions: string[] }>(
      `SELECT name, slug, permissions FROM roles ORDER BY name`,
    );
    return { org, apiClients, roles };
  });

  const members = await listMembers(ctx);
  const invitations = canManageTeam ? await listPendingInvitations(ctx) : [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">Organization, integrations and roles.</p>
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Organization</h2>
        <p className="text-sm text-slate-700">
          {data.org?.name} — product name:{' '}
          {(data.org?.settings as Record<string, unknown>)?.product_name as string ?? 'Nirog Bhoomi Research OS'}
        </p>
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Team</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Name</th>
              <th className="py-1">Email</th>
              <th className="py-1">Role</th>
              <th className="py-1">Status</th>
              {canManageTeam && <th className="py-1">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((m) => (
              <tr key={m.id}>
                <td className="py-1.5">{m.full_name}</td>
                <td className="py-1.5 text-slate-500">{m.email}</td>
                <td className="py-1.5 text-slate-500">{m.roles.join(', ') || '—'}</td>
                <td className="py-1.5">
                  <span className={`badge ${m.status === 'active' ? 'badge-approved' : 'badge-rejected'}`}>
                    {m.status}
                  </span>
                </td>
                {canManageTeam && (
                  <td className="py-1.5">
                    <MemberRowActions
                      userId={m.id}
                      currentUserId={ctx.userId}
                      status={m.status}
                      roles={data.roles.map((r) => ({ slug: r.slug, name: r.name }))}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {canManageTeam && (
          <>
            {invitations.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Pending invitations</h3>
                <ul className="space-y-1 text-sm">
                  {invitations.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between">
                      <span className="text-slate-700">
                        {inv.email} — {inv.role}
                        {inv.expired && <span className="ml-2 text-xs text-red-600">expired</span>}
                      </span>
                      <RevokeInvitationButton invitationId={inv.id} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 border-t border-slate-100 pt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Invite someone</h3>
              <InviteMemberForm roles={data.roles.map((r) => ({ slug: r.slug, name: r.name }))} />
            </div>
          </>
        )}
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Integrations (Custom GPT / API clients)</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Name</th>
              <th className="py-1">Type</th>
              <th className="py-1">Status</th>
              <th className="py-1">Last used</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.apiClients.map((c) => (
              <tr key={c.id}>
                <td className="py-1.5">{c.name}</td>
                <td className="py-1.5 text-slate-500">{c.client_type}</td>
                <td className="py-1.5">
                  <span className={`badge ${c.status === 'active' ? 'badge-approved' : 'badge-rejected'}`}>
                    {c.status}
                  </span>
                </td>
                <td className="py-1.5 text-slate-500">
                  {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : 'Never'}
                </td>
              </tr>
            ))}
            {data.apiClients.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-slate-400">
                  No API clients configured yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {canManageIntegrations && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">
              Connect a Custom GPT
            </h3>
            <CreateApiClientForm />
          </div>
        )}
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Roles</h2>
        <ul className="space-y-1 text-sm">
          {data.roles.map((r) => (
            <li key={r.slug} className="flex items-center justify-between">
              <span className="text-slate-800">{r.name}</span>
              <span className="text-xs text-slate-400">{r.permissions.length} permissions</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
