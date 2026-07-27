/**
 * Generates the action-risk matrix and API scope matrix directly from the
 * operation registry, so these reference documents can never drift from
 * what the API actually enforces.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerOperations } from '../src/api/operations';
import { allOperations } from '../src/api/registry';
import { SCOPES, SCOPE_PERMISSIONS, SYSTEM_ROLES } from '../src/domain/permissions';

registerOperations();

const DOCS_DIR = join(process.cwd(), 'docs');

async function writeActionRiskMatrix() {
  const operations = [...allOperations()].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return order[a.riskLevel] - order[b.riskLevel] || a.operationId.localeCompare(b.operationId);
  });

  const rows = operations.map((op) => {
    const confirm = op.mayRequireConfirmation ? 'Yes' : '—';
    return `| \`${op.operationId}\` | ${op.method} \`${op.path}\` | **${op.riskLevel}** | ${confirm} | ${op.permission ?? '—'} | ${op.internalOnly ? 'Yes' : '—'} |`;
  });

  const content = `# Action Risk Matrix

Generated from the operation registry (\`src/api/operations/*.ts\`) by \`npm run docs:generate\`. Do not hand-edit — edit the operation definitions and regenerate.

Risk tiers, as enforced by \`src/domain/risk.ts\`:

- **low** — read-only or additive and easily undone. Executes without confirmation.
- **medium** — needs clear intent; executes in the same turn.
- **high** — requires a server-issued confirmation (\`requestActionConfirmation\` → \`confirmAction\` → retry with \`confirmation_id\`).
- **critical** — administrators only, always confirmed. Several are excluded from the default Custom GPT action set (see "Internal only").

Some operations escalate risk dynamically (a batch above the configured threshold, or editing an approved/safety-relevant claim) — see \`src/domain/risk.ts\` \`RISK_MATRIX\` for the exact conditions; the table below shows the *baseline* level for a single, non-escalated call.

| Operation ID | Route | Risk | May require confirmation | Required permission | Internal only |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;

  await writeFile(join(DOCS_DIR, 'action-risk-matrix.md'), content, 'utf8');
}

async function writeScopeMatrix() {
  const rolePermissions = SYSTEM_ROLES.map((r) => `- **${r.name}** (\`${r.slug}\`): ${r.permissions.length} permissions — ${r.description}`).join('\n');

  const scopeRows = SCOPES.map((scope) => {
    const permissions = SCOPE_PERMISSIONS[scope];
    return `| \`${scope}\` | ${permissions.length > 0 ? permissions.map((p) => `\`${p}\``).join(', ') : '_(no permissions unlocked — read-only identity scope)_'} |`;
  });

  const operations = allOperations();
  const opsByScope = new Map<string, string[]>();
  for (const op of operations) {
    for (const scope of op.scopes) {
      opsByScope.set(scope, [...(opsByScope.get(scope) ?? []), op.operationId]);
    }
  }
  const usageRows = [...opsByScope.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, ops]) => `| \`${scope}\` | ${ops.length} | ${ops.slice(0, 6).map((o) => `\`${o}\``).join(', ')}${ops.length > 6 ? ', …' : ''} |`);

  const content = `# API Scope Matrix

Generated from \`src/domain/permissions.ts\` and the operation registry by \`npm run docs:generate\`. Do not hand-edit.

## How authorization is decided

Every request is authorized by the **intersection** of two independent checks:

1. **Permission** — does the acting user's role (plus any per-user override) grant the permission the operation requires?
2. **Scope** — for a scoped credential (OAuth token or API-key prototype), does it carry a scope that unlocks that permission? A first-party dashboard session is not scope-limited.

A broadly-scoped Custom GPT token therefore still cannot exceed what its underlying user could do in the dashboard, and a narrowly-scoped token cannot be used to reach past its own grant even for a highly privileged user.

## OAuth scopes → permissions unlocked

| Scope | Permissions it can unlock |
| --- | --- |
${scopeRows.join('\n')}

## Scope usage across operations

| Scope | Operations that accept it | Examples |
| --- | --- | --- |
${usageRows.join('\n')}

## System roles → permission counts

${rolePermissions}

See \`src/domain/permissions.ts\` for the full permission list and \`docs/action-risk-matrix.md\` for which operations additionally require a server-issued confirmation regardless of permission or scope.
`;

  await writeFile(join(DOCS_DIR, 'api-scope-matrix.md'), content, 'utf8');
}

async function main() {
  await writeActionRiskMatrix();
  await writeScopeMatrix();
  console.log('Wrote docs/action-risk-matrix.md and docs/api-scope-matrix.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
