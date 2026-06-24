-- 008_canonical_roles_and_audit.sql
-- Canonical role names, role permissions rewrite, system actors, audit events,
-- and notification actor typing.

ALTER TABLE auth.users
  ALTER COLUMN role SET DEFAULT 'REGULAR_USER';

CREATE TABLE IF NOT EXISTS auth.system_actors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth.audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_key TEXT,
  actor_type TEXT NOT NULL DEFAULT 'human',
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_key ON auth.audit_events(actor_key);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON auth.audit_events(action);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON auth.audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_uid_active ON workspace_members(user_uid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_activity_workspace_created ON workspace_activity(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_created ON workspace_invitations(workspace_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE auth.notifications ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'human';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.notifications ADD COLUMN actor_key TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

UPDATE auth.notifications
SET actor_key = COALESCE(actor_key, actor_id::text),
    actor_type = COALESCE(NULLIF(actor_type, ''), 'human')
WHERE actor_id IS NOT NULL OR actor_key IS NULL;

UPDATE auth.users
SET role = CASE role
  WHEN 'user' THEN 'REGULAR_USER'
  WHEN 'premium' THEN 'PRO_USER'
  WHEN 'support_provider' THEN 'SUPPORT_PROVIDER_USER'
  WHEN 'developer' THEN 'DEV_USER'
  WHEN 'admin' THEN 'ADMIN_USER'
  WHEN 'master' THEN 'ADMIN_USER'
  ELSE role
END;

UPDATE auth.sessions
SET role = CASE role
  WHEN 'user' THEN 'REGULAR_USER'
  WHEN 'premium' THEN 'PRO_USER'
  WHEN 'support_provider' THEN 'SUPPORT_PROVIDER_USER'
  WHEN 'developer' THEN 'DEV_USER'
  WHEN 'admin' THEN 'ADMIN_USER'
  WHEN 'master' THEN 'ADMIN_USER'
  ELSE role
END;

DELETE FROM role_permissions;

DELETE FROM permissions
WHERE name IN (
  'documents.create',
  'documents.edit',
  'documents.delete',
  'documents.share',
  'documents.export',
  'ai.use_basic',
  'ai.use_advanced',
  'ai.unlimited',
  'plagiarism.check',
  'ai_detector.check',
  'citations.manage',
  'workspace.create',
  'workspace.manage',
  'workspace.delete',
  'support.view_tickets',
  'support.resolve_tickets',
  'users.view',
  'users.manage',
  'users.assign_roles',
  'admin.access',
  'admin.view_analytics',
  'system.manage',
  'system.run_migrations',
  'system.impersonate'
);

INSERT INTO permissions (name, display_name, description, category) VALUES
  ('workspace.create.own', 'Create Initial Workspace', 'Create the default personal workspace during bootstrap', 'workspace'),
  ('workspace.create.multi', 'Create Multiple Workspaces', 'Create more than one owned workspace', 'workspace'),
  ('workspace.invite.members', 'Invite Workspace Members', 'Invite and manage members in owned workspaces', 'workspace'),
  ('workspace.manage.settings', 'Manage Workspace Settings', 'Update workspace settings and membership policy', 'workspace'),
  ('workspace.delete.owned', 'Delete Owned Workspace', 'Delete a workspace they own when policy permits', 'workspace'),
  ('projects.create', 'Create Projects', 'Create projects in accessible workspaces', 'projects'),
  ('projects.update', 'Update Projects', 'Update projects in accessible workspaces', 'projects'),
  ('projects.delete', 'Delete Projects', 'Delete projects in accessible workspaces', 'projects'),
  ('tasks.create', 'Create Tasks', 'Create tasks in accessible workspaces', 'tasks'),
  ('tasks.update', 'Update Tasks', 'Update tasks in accessible workspaces', 'tasks'),
  ('tasks.assign', 'Assign Tasks', 'Assign tasks in accessible workspaces', 'tasks'),
  ('tasks.delete', 'Delete Tasks', 'Delete tasks in accessible workspaces', 'tasks'),
  ('users.view', 'View Users', 'View user list and user profiles', 'admin'),
  ('users.manage.status', 'Manage User Status', 'Ban, disable, or reactivate users', 'admin'),
  ('users.manage.roles', 'Manage User Roles', 'Assign supported business roles', 'admin'),
  ('support.tickets.view', 'View Support Tickets', 'Inspect support requests and support state', 'support'),
  ('support.tickets.respond', 'Respond To Support Tickets', 'Send support responses and follow-up notifications', 'support'),
  ('support.users.inspect', 'Inspect Users For Support', 'Inspect user accounts for support purposes', 'support'),
  ('support.workspaces.inspect', 'Inspect Workspaces For Support', 'Inspect workspace state for support purposes', 'support'),
  ('admin.analytics.view', 'View Platform Analytics', 'View business and platform analytics', 'admin'),
  ('dev.debug.access', 'Developer Debug Access', 'Inspect technical system state and provider sync details', 'dev'),
  ('dev.featureflags.manage', 'Manage Feature Flags', 'Manage technical feature flags and related settings', 'dev'),
  ('dev.ops.run', 'Run Developer Operations', 'Execute approved technical maintenance workflows', 'dev'),
  ('system.notifications.send', 'Send System Notifications', 'Send platform-originated notifications', 'system'),
  ('system.jobs.execute', 'Execute System Jobs', 'Run scheduled and internal service jobs', 'system'),
  ('system.audit.write', 'Write Audit Events', 'Write immutable audit events for internal actions', 'system')
ON CONFLICT (name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    category = EXCLUDED.category;

INSERT INTO role_permissions (role, permission)
SELECT 'REGULAR_USER', permission
FROM (VALUES
  ('workspace.create.own'),
  ('workspace.delete.owned'),
  ('projects.create'),
  ('projects.update'),
  ('projects.delete'),
  ('tasks.create'),
  ('tasks.update'),
  ('tasks.assign'),
  ('tasks.delete')
) AS perms(permission)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT 'PRO_USER', permission
FROM (VALUES
  ('workspace.create.own'),
  ('workspace.create.multi'),
  ('workspace.invite.members'),
  ('workspace.manage.settings'),
  ('workspace.delete.owned'),
  ('projects.create'),
  ('projects.update'),
  ('projects.delete'),
  ('tasks.create'),
  ('tasks.update'),
  ('tasks.assign'),
  ('tasks.delete')
) AS perms(permission)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT 'SUPPORT_PROVIDER_USER', permission
FROM (VALUES
  ('support.tickets.view'),
  ('support.tickets.respond'),
  ('support.users.inspect'),
  ('support.workspaces.inspect')
) AS perms(permission)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT 'DEV_USER', permission
FROM (VALUES
  ('dev.debug.access'),
  ('dev.featureflags.manage'),
  ('dev.ops.run')
) AS perms(permission)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT 'ADMIN_USER', permission
FROM (VALUES
  ('users.view'),
  ('users.manage.status'),
  ('users.manage.roles'),
  ('admin.analytics.view')
) AS perms(permission)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT 'SYSTEM_USER', permission
FROM (VALUES
  ('system.notifications.send'),
  ('system.jobs.execute'),
  ('system.audit.write')
) AS perms(permission)
ON CONFLICT DO NOTHING;

UPDATE auth.users u
SET permissions = COALESCE((
  SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
  FROM role_permissions rp
  WHERE rp.role = u.role
), '[]'::jsonb);
