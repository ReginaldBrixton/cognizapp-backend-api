-- 018_institution_and_settings_enhancements.sql
-- Add institution section to user_settings, enhance privacy/ai defaults,
-- and add workspace_settings enhancements for institution/academic use

-- ── 1. Add institution column to user_settings ──────────────────────────────
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS institution JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── 2. Backfill institution defaults for existing rows ───────────────────────
UPDATE user_settings SET
  institution = '{
    "name": "",
    "type": "university",
    "department": "",
    "position": "",
    "country": "",
    "city": "",
    "website": "",
    "orcid": "",
    "google_scholar_id": "",
    "research_gate_id": "",
    "research_interests": [],
    "affiliation_verified": false
  }'::jsonb
WHERE institution = '{}'::jsonb;

-- ── 3. Enhance privacy defaults (add missing fields) ────────────────────────
UPDATE user_settings SET
  privacy = jsonb_set(
    COALESCE(privacy, '{}'::jsonb),
    '{profileVisibility}',
    COALESCE(privacy->>'profileVisibility', '"workspace"')::jsonb
  )
WHERE privacy->>'profileVisibility' IS NULL;

UPDATE user_settings SET
  privacy = jsonb_set(
    COALESCE(privacy, '{}'::jsonb),
    '{activityStatus}',
    COALESCE(privacy->>'activityStatus', 'true')::jsonb
  )
WHERE privacy->>'activityStatus' IS NULL;

UPDATE user_settings SET
  privacy = jsonb_set(
    COALESCE(privacy, '{}'::jsonb),
    '{readReceipts}',
    COALESCE(privacy->>'readReceipts', 'true')::jsonb
  )
WHERE privacy->>'readReceipts' IS NULL;

UPDATE user_settings SET
  privacy = jsonb_set(
    COALESCE(privacy, '{}'::jsonb),
    '{analyticsOptIn}',
    COALESCE(privacy->>'analyticsOptIn', 'false')::jsonb
  )
WHERE privacy->>'analyticsOptIn' IS NULL;

UPDATE user_settings SET
  privacy = jsonb_set(
    COALESCE(privacy, '{}'::jsonb),
    '{dataExportRequested}',
    COALESCE(privacy->>'dataExportRequested', 'false')::jsonb
  )
WHERE privacy->>'dataExportRequested' IS NULL;

UPDATE user_settings SET
  privacy = jsonb_set(
    COALESCE(privacy, '{}'::jsonb),
    '{dataRetentionDays}',
    COALESCE(privacy->>'dataRetentionDays', '90')::jsonb
  )
WHERE privacy->>'dataRetentionDays' IS NULL;

-- ── 4. Enhance AI defaults (add missing fields) ────────────────────────────
UPDATE user_settings SET
  ai = jsonb_set(
    COALESCE(ai, '{}'::jsonb),
    '{preferredModels}',
    COALESCE(ai->'preferredModels', '[]'::jsonb)
  )
WHERE ai->'preferredModels' IS NULL;

UPDATE user_settings SET
  ai = jsonb_set(
    COALESCE(ai, '{}'::jsonb),
    '{historyRetention}',
    COALESCE(ai->>'historyRetention', '30')::jsonb
  )
WHERE ai->>'historyRetention' IS NULL;

UPDATE user_settings SET
  ai = jsonb_set(
    COALESCE(ai, '{}'::jsonb),
    '{privacyMode}',
    COALESCE(ai->>'privacyMode', 'false')::jsonb
  )
WHERE ai->>'privacyMode' IS NULL;

-- ── 5. Enhance profile defaults (add academic fields) ──────────────────────
UPDATE user_settings SET
  profile = jsonb_set(
    COALESCE(profile, '{}'::jsonb),
    '{socialLinks}',
    COALESCE(profile->'socialLinks', '{"twitter":"","linkedin":"","github":""}'::jsonb)
  )
WHERE profile->'socialLinks' IS NULL;

-- ── 6. Add institution column to workspace_settings ─────────────────────────
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS institution JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill workspace institution defaults
UPDATE workspace_settings SET
  institution = '{
    "name": "",
    "type": "university",
    "department": "",
    "country": "",
    "city": "",
    "website": "",
    "orcid": "",
    "accreditation": "",
    "affiliation_verified": false
  }'::jsonb
WHERE institution = '{}'::jsonb;
