-- 075_magic_link_auth.sql
-- Add magic link token support to auth.auth_codes.
-- When a user requests an OTP, a random magic link token is also generated.
-- Its hash is stored alongside the code hash so the user can either:
--   1. Enter the 6-digit code manually (existing flow), or
--   2. Click a magic link in the email that contains the token.

ALTER TABLE auth.auth_codes
  ADD COLUMN IF NOT EXISTS magic_link_token_hash TEXT;

ALTER TABLE auth.auth_codes
  ADD CONSTRAINT chk_auth_codes_magic_link_token_hash_sha256
  CHECK (magic_link_token_hash IS NULL OR magic_link_token_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS idx_auth_codes_magic_link_token_hash
  ON auth.auth_codes(magic_link_token_hash)
  WHERE magic_link_token_hash IS NOT NULL;
