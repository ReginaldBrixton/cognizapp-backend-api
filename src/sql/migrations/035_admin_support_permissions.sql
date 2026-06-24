-- 035_admin_support_permissions.sql
-- Ensure ADMIN_USER carries support desk permissions in the database mapping.

INSERT INTO role_permissions (role, permission)
SELECT 'ADMIN_USER', permission
FROM (VALUES
    ('support.tickets.view'),
    ('support.tickets.respond'),
    ('support.users.inspect'),
    ('support.workspaces.inspect')
) AS required(permission)
ON CONFLICT (role, permission) DO NOTHING;

UPDATE auth.users
SET permissions = COALESCE((
    SELECT jsonb_agg(permission ORDER BY permission)
    FROM role_permissions
    WHERE role = auth.users.role
), auth.users.permissions, '[]'::jsonb),
updated_at = NOW()
WHERE role = 'ADMIN_USER';

UPDATE auth.users
SET permissions = COALESCE(permissions, '[]'::jsonb) - 'support.users.inspect' - 'support.workspaces.inspect',
    updated_at = NOW()
WHERE role = 'SUPPORT_PROVIDER_USER';
