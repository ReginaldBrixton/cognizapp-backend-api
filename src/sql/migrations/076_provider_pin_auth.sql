-- 076_provider_pin_auth.sql
-- Username + PIN (argon2id) authentication for the provider portal, and
-- device-id binding for sessions so activity logs can be correlated across
-- logins from the same physical device.

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS username TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS pin_hash TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS pin_failed_logins INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_pin_failed_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Username is optional (legacy email-only accounts have none) but must be
-- unique among non-deleted accounts when present. Stored case-insensitively
-- via a unique index on lower(username).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower_unique
  ON auth.users (lower(username))
  WHERE username IS NOT NULL AND deleted_at IS NULL;

DO $$ BEGIN
  ALTER TABLE auth.users ADD CONSTRAINT chk_users_pin_counters
    CHECK (pin_failed_logins >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD CONSTRAINT chk_users_username_shape
    CHECK (
      username IS NULL
      OR (length(username) BETWEEN 3 AND 64
          AND username ~ '^[A-Za-z0-9._-]+$')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bind sessions to a stable device_id cookie so repeat logins from the same
-- device can be correlated in auth.activity_log metadata.
DO $$ BEGIN
  ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS device_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_user_device
  ON auth.sessions (user_id, device_id)
  WHERE device_id IS NOT NULL AND is_revoked = FALSE;

-- Speed up activity-log lookups filtered by device_id (metadata->>'device_id').
CREATE INDEX IF NOT EXISTS idx_activity_log_device_id
  ON auth.activity_log ((metadata->>'device_id'))
  WHERE metadata ? 'device_id';

-- Every PIN login attempt (success or failure, known or unknown username) is
-- recorded here so we can throttle by IP *and* lock by account, even when the
-- username does not resolve to a user (activity_log.user_id is NOT NULL and
-- cannot be used for unknown-username attempts).
CREATE TABLE IF NOT EXISTS auth.pin_login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    username_attempted TEXT NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    device_id TEXT,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pin_attempts_ip_created
  ON auth.pin_login_attempts (ip_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pin_attempts_user_created
  ON auth.pin_login_attempts (user_id, created_at DESC)
  WHERE success = FALSE;

CREATE INDEX IF NOT EXISTS idx_pin_attempts_device_created
  ON auth.pin_login_attempts (device_id, created_at DESC)
  WHERE device_id IS NOT NULL;
