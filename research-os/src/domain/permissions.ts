/**
 * Explicit permissions. Roles are bundles of these; the role label is
 * never itself the authority, so a role can be re-shaped later without
 * touching any call site.
 */
export const PERMISSIONS = [
  'source.read',
  'source.create',
  'source.update',
  'source.archive',
  'source.delete_permanent',
  'source.approve',
  'source.reject',
  'source.restore',
  'source.reprocess',
  'source.lock_fields',
  'source.merge',

  'collection.read',
  'collection.create',
  'collection.update',
  'collection.archive',
  'collection.manage_members',

  'taxonomy.read',
  'taxonomy.create',
  'taxonomy.update',
  'taxonomy.merge',
  'taxonomy.archive',

  'claim.read',
  'claim.create',
  'claim.update',
  'claim.review',
  'claim.archive',

  'annotation.read',
  'annotation.create',
  'annotation.update_own',
  'annotation.update_any',
  'annotation.delete_own',
  'annotation.delete_any',

  'brief.read',
  'brief.create',
  'brief.update',
  'brief.approve',

  'research.run',
  'content.generate',
  'content.approve',
  'knowledge.read',

  'audit.read',
  'integration.manage',
  'user.manage',
  'role.manage',
  'org.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

const READ_ONLY: Permission[] = [
  'source.read',
  'collection.read',
  'taxonomy.read',
  'claim.read',
  'annotation.read',
  'brief.read',
  'knowledge.read',
];

/**
 * Default system roles. `permissions` is copied into the roles table at
 * organization creation, after which an administrator may edit them.
 */
export const SYSTEM_ROLES: Array<{
  slug: string;
  name: string;
  description: string;
  permissions: Permission[];
}> = [
  {
    slug: 'administrator',
    name: 'Administrator',
    description:
      'Full control of the organization, including users, roles, integrations, taxonomy, retention and permanent deletion.',
    permissions: ALL,
  },
  {
    slug: 'research_manager',
    name: 'Research manager',
    description:
      'Runs the research operation: manages sources and collections, approves sources, assigns review work and generates briefs.',
    permissions: [
      ...READ_ONLY,
      'source.create',
      'source.update',
      'source.archive',
      'source.approve',
      'source.reject',
      'source.restore',
      'source.reprocess',
      'source.merge',
      'collection.create',
      'collection.update',
      'collection.archive',
      'collection.manage_members',
      'taxonomy.create',
      'taxonomy.update',
      'taxonomy.merge',
      'taxonomy.archive',
      'claim.create',
      'claim.update',
      'claim.archive',
      'annotation.create',
      'annotation.update_own',
      'annotation.update_any',
      'annotation.delete_own',
      'brief.create',
      'brief.update',
      'brief.approve',
      'research.run',
      'content.generate',
      'audit.read',
    ],
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description:
      'Adds and organizes sources, annotates, runs searches and research jobs, and submits work for review.',
    permissions: [
      ...READ_ONLY,
      'source.create',
      'source.update',
      'source.reprocess',
      'collection.create',
      'collection.update',
      'taxonomy.create',
      'claim.create',
      'claim.update',
      'annotation.create',
      'annotation.update_own',
      'annotation.delete_own',
      'brief.create',
      'brief.update',
      'research.run',
      'content.generate',
    ],
  },
  {
    slug: 'clinical_reviewer',
    name: 'Clinical reviewer',
    description:
      'Reviews health claims, corrects evidence classifications, adds safety qualifications and locks reviewed fields.',
    permissions: [
      ...READ_ONLY,
      'source.update',
      'source.approve',
      'source.reject',
      'source.lock_fields',
      'claim.create',
      'claim.update',
      'claim.review',
      'claim.archive',
      'annotation.create',
      'annotation.update_own',
      'annotation.update_any',
      'annotation.delete_own',
      'brief.approve',
    ],
  },
  {
    slug: 'content_team',
    name: 'Content team member',
    description:
      'Searches approved evidence, drafts content and briefs, and requests research. Cannot approve clinical claims.',
    permissions: [
      ...READ_ONLY,
      'collection.create',
      'collection.update',
      'annotation.create',
      'annotation.update_own',
      'annotation.delete_own',
      'brief.create',
      'brief.update',
      'content.generate',
      'research.run',
    ],
  },
  {
    slug: 'viewer',
    name: 'Viewer',
    description: 'Reads approved knowledge and exports permitted citations. Cannot modify records.',
    permissions: READ_ONLY,
  },
];

/**
 * OAuth scopes exposed to the Custom GPT. A scope is a coarse grant; the
 * user's own permissions still apply underneath, and the effective
 * authority is the intersection of the two.
 */
export const SCOPES = [
  'profile.read',
  'knowledge.read',
  'source.read',
  'source.write',
  'source.review',
  'collection.read',
  'collection.write',
  'taxonomy.read',
  'taxonomy.write',
  'claim.read',
  'claim.write',
  'claim.review',
  'annotation.read',
  'annotation.write',
  'research.run',
  'brief.read',
  'brief.write',
  'content.generate',
  'audit.read',
  'admin.integrations',
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * Which permissions each scope may unlock. A request must satisfy both
 * the scope check and the permission check; neither substitutes for the
 * other. This is what stops a broadly-scoped token from acting beyond
 * what its user could do in the dashboard.
 */
export const SCOPE_PERMISSIONS: Record<Scope, Permission[]> = {
  'profile.read': [],
  'knowledge.read': ['knowledge.read', 'source.read'],
  'source.read': ['source.read'],
  'source.write': ['source.create', 'source.update', 'source.reprocess', 'source.archive', 'source.restore'],
  'source.review': ['source.approve', 'source.reject', 'source.lock_fields'],
  'collection.read': ['collection.read'],
  'collection.write': ['collection.create', 'collection.update', 'collection.archive', 'collection.manage_members'],
  'taxonomy.read': ['taxonomy.read'],
  'taxonomy.write': ['taxonomy.create', 'taxonomy.update', 'taxonomy.merge', 'taxonomy.archive'],
  'claim.read': ['claim.read'],
  'claim.write': ['claim.create', 'claim.update', 'claim.archive'],
  'claim.review': ['claim.review'],
  'annotation.read': ['annotation.read'],
  'annotation.write': [
    'annotation.create',
    'annotation.update_own',
    'annotation.update_any',
    'annotation.delete_own',
    'annotation.delete_any',
  ],
  'research.run': ['research.run'],
  'brief.read': ['brief.read'],
  'brief.write': ['brief.create', 'brief.update', 'brief.approve'],
  'content.generate': ['content.generate', 'content.approve'],
  'audit.read': ['audit.read'],
  'admin.integrations': ['integration.manage'],
};

/** The scopes that must be present for a given permission to be usable. */
export function scopesGranting(permission: Permission): Scope[] {
  return (Object.keys(SCOPE_PERMISSIONS) as Scope[]).filter((s) =>
    SCOPE_PERMISSIONS[s].includes(permission),
  );
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}
