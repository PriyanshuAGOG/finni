import Link from 'next/link';
import { requireSessionContext } from '../../lib/session';
import { listCategories, type CategoryNode } from '../../../services/taxonomy';

function TreeNode({ node, depth }: { node: CategoryNode; depth: number }) {
  return (
    <div>
      <Link
        href={`/library?category_id=${node.id}`}
        className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-slate-50"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        <span className="text-slate-800 hover:text-brand-600">{node.name}</span>
        {node.usage_count !== undefined && (
          <span className="text-xs text-slate-400">{node.usage_count} source(s)</span>
        )}
      </Link>
      {node.children.map((child) => (
        <TreeNode key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export default async function CategoriesPage() {
  const ctx = await requireSessionContext();
  const result = await listCategories(ctx, { tree: true, includeUsageCounts: true });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Categories</h1>
        <p className="text-sm text-slate-500">{result.categories.length} categories in the taxonomy. Click one to see its sources.</p>
      </div>

      <div className="card p-4">
        {(result.tree ?? []).map((node) => (
          <TreeNode key={node.id} node={node} depth={0} />
        ))}
        {(result.tree ?? []).length === 0 && (
          <p className="p-4 text-sm text-slate-400">No categories yet.</p>
        )}
      </div>
    </div>
  );
}
