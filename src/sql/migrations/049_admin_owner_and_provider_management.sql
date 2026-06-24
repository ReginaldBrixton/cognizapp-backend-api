-- 049_admin_owner_and_provider_management.sql
-- 1. Establish reginaldbrixton@gmail.com as the platform owner/admin.
-- 2. Add display_name to privileged_access_grants so admins can manage
--    provider accounts (add / edit / remove) with a friendly label.

-- ── Provider management: friendly name + faster lookups ──────────────────────
ALTER TABLE auth.privileged_access_grants
  ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE INDEX IF NOT EXISTS idx_privileged_access_grants_role_status
  ON auth.privileged_access_grants (role, status);

-- ── Seed the owner admin grant ───────────────────────────────────────────────
INSERT INTO auth.privileged_access_grants (email, role, status, display_name, metadata)
VALUES (
  'reginaldbrixton@gmail.com',
  'ADMIN_USER',
  'active',
  'Reginald Brixton',
  '{"seeded": true, "reason": "platform_owner_admin"}'::jsonb
)
ON CONFLICT (lower(email), role) DO UPDATE
SET status = 'active',
    display_name = COALESCE(auth.privileged_access_grants.display_name, EXCLUDED.display_name),
    revoked_at = NULL,
    revoked_by = NULL,
    updated_at = NOW(),
    metadata = auth.privileged_access_grants.metadata || EXCLUDED.metadata;

-- ── Promote the owner account if it already exists ──────────────────────────
UPDATE auth.users
SET role = 'ADMIN_USER',
    permissions = COALESCE((
      SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
      FROM role_permissions rp
      WHERE rp.role = 'ADMIN_USER'
    ), '[]'::jsonb),
    role_assigned_at = COALESCE(role_assigned_at, NOW()),
    updated_at = NOW()
WHERE lower(email) = 'reginaldbrixton@gmail.com';
