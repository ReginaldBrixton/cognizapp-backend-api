-- 078_phone_auth_constraints.sql
-- Update constraints to support phone authentication provider

-- Drop and recreate chk_users_provider_integrity to include 'phone' provider
ALTER TABLE auth.users DROP CONSTRAINT IF EXISTS chk_users_provider_integrity;

DO $$ BEGIN
  ALTER TABLE auth.users ADD CONSTRAINT chk_users_provider_integrity
    CHECK (
      (provider IS NULL AND provider_uid IS NULL)
      OR (provider IN ('email', 'google') AND provider_uid IS NULL)
      OR (provider IN ('firebase', 'google', 'phone') AND provider_uid IS NOT NULL AND length(provider_uid) BETWEEN 6 AND 256)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
