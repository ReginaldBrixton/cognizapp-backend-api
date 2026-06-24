-- 041_privileged_access_grants.sql
-- Explicit allow-list for admin/provider access.

CREATE TABLE IF NOT EXISTS auth.privileged_access_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT,
    invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT privileged_access_grants_role_check
        CHECK (role IN ('ADMIN_USER', 'SUPPORT_PROVIDER_USER')),
    CONSTRAINT privileged_access_grants_status_check
        CHECK (status IN ('active', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_privileged_access_grants_email_role
    ON auth.privileged_access_grants (lower(email), role);

CREATE INDEX IF NOT EXISTS idx_privileged_access_grants_active_email
    ON auth.privileged_access_grants (lower(email), status);

INSERT INTO auth.privileged_access_grants (email, role, status, metadata)
VALUES (
    'cognizap.ai@gmail.com',
    'ADMIN_USER',
    'active',
    '{"seeded": true, "reason": "initial_admin_support_access"}'::jsonb
)
ON CONFLICT (lower(email), role) DO UPDATE
SET status = 'active',
    revoked_at = NULL,
    revoked_by = NULL,
    updated_at = NOW(),
    metadata = auth.privileged_access_grants.metadata || EXCLUDED.metadata;

UPDATE auth.users
SET role = 'ADMIN_USER',
    permissions = COALESCE((
        SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
        FROM role_permissions rp
        WHERE rp.role = 'ADMIN_USER'
    ), '[]'::jsonb),
    role_assigned_at = COALESCE(role_assigned_at, NOW()),
    updated_at = NOW()
WHERE lower(email) = 'cognizap.ai@gmail.com';
