-- 031_email_only_provider.sql
-- Tighten auth.users provider integrity after Firebase/Google auth removal.

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

ALTER TABLE auth.users ALTER COLUMN provider SET DEFAULT 'email';

ALTER TABLE auth.users ADD CONSTRAINT chk_users_provider_integrity
  CHECK (
    (provider IS NULL AND provider_uid IS NULL)
    OR (provider IN ('email', 'google') AND provider_uid IS NULL)
    OR (provider IN ('firebase', 'google') AND provider_uid IS NOT NULL AND length(provider_uid) BETWEEN 6 AND 256)
  );
