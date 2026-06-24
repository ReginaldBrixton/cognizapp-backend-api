-- 017_auth_security_hardening.sql
-- Strict auth/data guardrails for live Google OAuth and session handling.

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

UPDATE auth.users
SET email = lower(trim(email))
WHERE email <> lower(trim(email));

UPDATE auth.sessions
SET revoked_at = NULL
WHERE is_revoked = FALSE AND revoked_at IS NOT NULL;

UPDATE auth.sessions
SET revoked_at = COALESCE(revoked_at, NOW())
WHERE is_revoked = TRUE AND revoked_at IS NULL;

DO $$ BEGIN
  ALTER TABLE auth.users ADD CONSTRAINT chk_users_email_shape
    CHECK (
      email = lower(trim(email))
      AND length(email) BETWEEN 3 AND 254
      AND email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD CONSTRAINT chk_users_provider_integrity
    CHECK (
      (provider IS NULL AND provider_uid IS NULL)
      OR (provider IN ('email', 'google') AND provider_uid IS NULL)
      OR (provider IN ('firebase', 'google') AND provider_uid IS NOT NULL AND length(provider_uid) BETWEEN 6 AND 256)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD CONSTRAINT chk_users_login_counters
    CHECK (login_count >= 0 AND failed_logins >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.sessions ADD CONSTRAINT chk_sessions_hashes_sha256
    CHECK (
      token_hash ~ '^(pending_[0-9]+|[0-9a-f]{64})$'
      AND refresh_token_hash ~ '^(pending_[0-9]+_refresh|[0-9a-f]{64})$'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.sessions ADD CONSTRAINT chk_sessions_expiry_order
    CHECK (refresh_expires_at IS NULL OR refresh_expires_at >= expires_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.sessions ADD CONSTRAINT chk_sessions_revocation_consistency
    CHECK (
      (is_revoked = FALSE AND revoked_at IS NULL)
      OR (is_revoked = TRUE AND revoked_at IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique
  ON auth.users (lower(email))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_provider_uid_unique
  ON auth.users (provider, provider_uid)
  WHERE provider = 'firebase' AND provider_uid IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_active_unrevoked_lookup
  ON auth.sessions (user_id, expires_at DESC, last_active DESC)
  WHERE is_revoked = FALSE;

CREATE INDEX IF NOT EXISTS idx_activity_log_user_created
  ON auth.activity_log (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION validate_workspace_ownership()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_exists BOOLEAN;
BEGIN
    v_owner_exists := EXISTS(
        SELECT 1 FROM auth.users
        WHERE id::text = NEW.owner_uid
          AND status = 'active'
          AND deleted_at IS NULL
    );

    IF NOT v_owner_exists THEN
        RAISE EXCEPTION 'Workspace owner_uid % does not match an active user', NEW.owner_uid;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
