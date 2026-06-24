-- 030_email_otp_auth.sql
-- Email OTP authentication replacing Firebase/Google provider auth.

CREATE TABLE IF NOT EXISTS auth.auth_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  CONSTRAINT chk_auth_codes_email_shape CHECK (
    email = lower(trim(email))
    AND length(email) BETWEEN 3 AND 254
    AND email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'
  ),
  CONSTRAINT chk_auth_codes_code_hash_sha256 CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_auth_codes_attempts CHECK (attempts >= 0),
  CONSTRAINT chk_auth_codes_verified_at CHECK (
    (verified = FALSE AND verified_at IS NULL)
    OR (verified = TRUE AND verified_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_email_created
  ON auth.auth_codes(email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_codes_email_verified_expires
  ON auth.auth_codes(email, verified, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_codes_ip_created
  ON auth.auth_codes(ip_address, created_at DESC)
  WHERE ip_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_codes_expires_at
  ON auth.auth_codes(expires_at);

CREATE OR REPLACE FUNCTION auth.cleanup_expired_auth_codes()
RETURNS void AS $$
BEGIN
  DELETE FROM auth.auth_codes WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

ALTER TABLE auth.users DROP CONSTRAINT IF EXISTS chk_users_provider_integrity;

/*
UPDATE auth.users
SET provider = 'email',
    provider_uid = NULL,
    providers = ARRAY['email']::text[],
    is_sso_user = FALSE,
    email_verified = COALESCE(email_verified, TRUE),
    confirmed_at = COALESCE(confirmed_at, NOW()),
    raw_app_meta_data = jsonb_set(
      COALESCE(raw_app_meta_data, '{}'::jsonb),
      '{provider}',
      '"email"'::jsonb,
      TRUE
    ),
    raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) - 'firebase' - 'firebase_uid',
    identity_data = (
      COALESCE(identity_data, '{}'::jsonb)
      - 'provider_id'
      - 'provider_uid'
      - 'firebase_uid'
      - 'picture'
      - 'avatar_url'
    )
      || jsonb_build_object('provider', 'email', 'email_verified', TRUE),
    avatar_url = CASE
      WHEN avatar_url ILIKE '%googleusercontent.com%' THEN NULL
      ELSE avatar_url
    END,
    updated_at = NOW()
WHERE provider = 'firebase'
   OR provider_uid IS NOT NULL
   OR provider IS DISTINCT FROM 'email'
   OR avatar_url ILIKE '%googleusercontent.com%';
*/

ALTER TABLE auth.users ADD CONSTRAINT chk_users_provider_integrity
  CHECK (
    (provider IS NULL AND provider_uid IS NULL)
    OR (provider IN ('email', 'google') AND provider_uid IS NULL)
    OR (provider IN ('firebase', 'google') AND provider_uid IS NOT NULL AND length(provider_uid) BETWEEN 6 AND 256)
  );

ALTER TABLE auth.users ALTER COLUMN provider SET DEFAULT 'email';
