-- 006_roles_permissions.sql
-- Roles hierarchy: user < premium < support_provider < developer < admin < master
-- Adds a permissions catalog, role_permissions junction, and extra columns on users.

-- ── Extend auth.users ───────────────────────────────────────────────────

ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS permissions     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS role_assigned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS role_assigned_by TEXT;

-- ── Permissions catalog ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS permissions (
    id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT  NOT NULL UNIQUE,    -- e.g. 'documents.create'
    display_name TEXT NOT NULL,
    description TEXT  NOT NULL DEFAULT '',
    category    TEXT  NOT NULL,           -- 'documents' | 'ai' | 'workspace' | 'admin' | 'system'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO permissions (name, display_name, description, category) VALUES
    -- Document permissions
    ('documents.create',          'Create Documents',          'Create new documents, spreadsheets, or presentations', 'documents'),
    ('documents.edit',            'Edit Documents',            'Edit any document they have access to',                'documents'),
    ('documents.delete',          'Delete Documents',          'Delete documents they own',                            'documents'),
    ('documents.share',           'Share Documents',           'Share documents with others',                          'documents'),
    ('documents.export',          'Export Documents',          'Export documents to PDF, DOCX, etc.',                  'documents'),

    -- AI permissions
    ('ai.use_basic',              'Basic AI Features',         'Use basic AI writing assistance',                      'ai'),
    ('ai.use_advanced',           'Advanced AI Features',      'Use advanced AI models and features',                  'ai'),
    ('ai.unlimited',              'Unlimited AI Usage',        'No rate limits on AI usage',                           'ai'),

    -- Research tool permissions
    ('plagiarism.check',          'Plagiarism Check',          'Run plagiarism detection scans',                       'research'),
    ('ai_detector.check',         'AI Detector',               'Use the AI content detector',                          'research'),
    ('citations.manage',          'Manage Citations',          'Create and manage citation libraries',                  'research'),

    -- Workspace permissions
    ('workspace.create',          'Create Workspaces',         'Create new workspaces',                                'workspace'),
    ('workspace.manage',          'Manage Workspace',          'Manage workspace members and settings',                'workspace'),
    ('workspace.delete',          'Delete Workspace',          'Delete a workspace they own',                          'workspace'),

    -- Support permissions
    ('support.view_tickets',      'View Support Tickets',      'View user support tickets',                            'support'),
    ('support.resolve_tickets',   'Resolve Support Tickets',   'Resolve or escalate support tickets',                  'support'),

    -- Admin permissions
    ('users.view',                'View Users',                'View user list and profiles',                          'admin'),
    ('users.manage',              'Manage Users',              'Create, edit, ban, or delete users',                   'admin'),
    ('users.assign_roles',        'Assign Roles',              'Assign roles up to their own level',                   'admin'),
    ('admin.access',              'Admin Panel Access',        'Access the admin dashboard',                           'admin'),
    ('admin.view_analytics',      'View Platform Analytics',   'View platform-wide usage analytics',                   'admin'),

    -- System permissions
    ('system.manage',             'System Management',         'Full system configuration access',                     'system'),
    ('system.run_migrations',     'Run Migrations',            'Execute database migrations',                          'system'),
    ('system.impersonate',        'Impersonate Users',         'Impersonate any user account',                         'system')
ON CONFLICT (name) DO NOTHING;

-- ── Role → permissions mapping ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS role_permissions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role       TEXT NOT NULL,
    permission TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (role, permission)
);

-- user role
INSERT INTO role_permissions (role, permission)
SELECT 'user', name FROM permissions
WHERE name IN (
    'documents.create', 'documents.edit', 'documents.delete', 'documents.share', 'documents.export',
    'ai.use_basic',
    'plagiarism.check', 'ai_detector.check', 'citations.manage',
    'workspace.create', 'workspace.manage', 'workspace.delete'
) ON CONFLICT DO NOTHING;

-- premium role (everything user has + advanced AI)
INSERT INTO role_permissions (role, permission)
SELECT 'premium', name FROM permissions
WHERE name IN (
    'documents.create', 'documents.edit', 'documents.delete', 'documents.share', 'documents.export',
    'ai.use_basic', 'ai.use_advanced',
    'plagiarism.check', 'ai_detector.check', 'citations.manage',
    'workspace.create', 'workspace.manage', 'workspace.delete'
) ON CONFLICT DO NOTHING;

-- support_provider role
INSERT INTO role_permissions (role, permission)
SELECT 'support_provider', name FROM permissions
WHERE name IN (
    'documents.create', 'documents.edit', 'documents.delete', 'documents.share', 'documents.export',
    'ai.use_basic', 'ai.use_advanced',
    'plagiarism.check', 'ai_detector.check', 'citations.manage',
    'workspace.create', 'workspace.manage', 'workspace.delete',
    'support.view_tickets', 'support.resolve_tickets',
    'users.view'
) ON CONFLICT DO NOTHING;

-- developer role
INSERT INTO role_permissions (role, permission)
SELECT 'developer', name FROM permissions
WHERE name IN (
    'documents.create', 'documents.edit', 'documents.delete', 'documents.share', 'documents.export',
    'ai.use_basic', 'ai.use_advanced', 'ai.unlimited',
    'plagiarism.check', 'ai_detector.check', 'citations.manage',
    'workspace.create', 'workspace.manage', 'workspace.delete',
    'support.view_tickets', 'support.resolve_tickets',
    'users.view', 'users.manage',
    'admin.access', 'admin.view_analytics'
) ON CONFLICT DO NOTHING;

-- admin role
INSERT INTO role_permissions (role, permission)
SELECT 'admin', name FROM permissions
WHERE name IN (
    'documents.create', 'documents.edit', 'documents.delete', 'documents.share', 'documents.export',
    'ai.use_basic', 'ai.use_advanced', 'ai.unlimited',
    'plagiarism.check', 'ai_detector.check', 'citations.manage',
    'workspace.create', 'workspace.manage', 'workspace.delete',
    'support.view_tickets', 'support.resolve_tickets',
    'users.view', 'users.manage', 'users.assign_roles',
    'admin.access', 'admin.view_analytics',
    'system.manage', 'system.run_migrations'
) ON CONFLICT DO NOTHING;

-- master role (all permissions)
INSERT INTO role_permissions (role, permission)
SELECT 'master', name FROM permissions
ON CONFLICT DO NOTHING;

UPDATE auth.users u
SET permissions = COALESCE((
    SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
    FROM role_permissions rp
    WHERE rp.role = u.role
), '[]'::jsonb);
