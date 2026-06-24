-- 019_workspace_settings_schema_alignment.sql
-- Align workspace_settings JSONB keys with frontend types (camelCase).
-- Frontend expects camelCase keys; backend was storing snake_case keys.

-- ── 1. Backfill general section with real workspace name/description ──
-- Frontend expects: { name, description, visibility, allowMemberInvites, requireApproval, defaultRole }
UPDATE workspace_settings ws
SET general = jsonb_build_object(
    'name', COALESCE(ws.general->>'name', w.name, ''),
    'description', COALESCE(ws.general->>'description', w.description, ''),
    'visibility', COALESCE(ws.access->>'visibility', 'private'),
    'allowMemberInvites', COALESCE(ws.access->>'allow_member_invites', 'true'),
    'requireApproval', COALESCE(ws.access->>'require_approval', 'false'),
    'defaultRole', COALESCE(ws.access->>'default_member_role', '"member"')
)
FROM workspaces w
WHERE ws.workspace_id = w.id::text
  AND (ws.general->>'name' IS NULL
    OR ws.general->>'workspace_name' IS NOT NULL
    OR ws.general->>'name' = '');

-- ── 2. Backfill storage section with camelCase keys ──
-- Frontend expects: { maxFileSize, allowedFileTypes, autoCleanup, deletedRetentionDays }
UPDATE workspace_settings SET
  storage = jsonb_build_object(
    'maxFileSize', COALESCE((storage->>'max_file_size_mb')::int, (storage->>'maxFileSize')::int, 100),
    'allowedFileTypes', COALESCE(storage->'allowedFileTypes', '[".pdf",".doc",".docx",".txt",".rtf",".odt",".xls",".xlsx",".csv",".ods",".ppt",".pptx",".odp",".jpg",".jpeg",".png",".gif",".svg",".webp",".mp3",".wav",".mp4",".webm",".zip",".tar",".gz",".js",".ts",".py",".json",".xml",".html",".css"]'::jsonb),
    'autoCleanup', COALESCE((storage->>'auto_cleanup')::boolean, (storage->>'autoCleanup')::boolean, false),
    'deletedRetentionDays', COALESCE((storage->>'retention_days')::int, (storage->>'deletedRetentionDays')::int, 30)
  )
WHERE storage->>'maxFileSize' IS NULL
   OR storage->>'max_file_size_mb' IS NOT NULL;

-- ── 3. Backfill institution section with camelCase keys ──
-- Frontend expects: { name, type, department, country, city, website, orcid, accreditation, affiliationVerified }
UPDATE workspace_settings SET
  institution = jsonb_build_object(
    'name', COALESCE(institution->>'name', ''),
    'type', COALESCE(institution->>'type', 'university'),
    'department', COALESCE(institution->>'department', ''),
    'country', COALESCE(institution->>'country', ''),
    'city', COALESCE(institution->>'city', ''),
    'website', COALESCE(institution->>'website', ''),
    'orcid', COALESCE(institution->>'orcid', ''),
    'accreditation', COALESCE(institution->>'accreditation', ''),
    'affiliationVerified', COALESCE((institution->>'affiliation_verified')::boolean, (institution->>'affiliationVerified')::boolean, false)
  )
WHERE institution->>'affiliationVerified' IS NULL
   OR institution->>'affiliation_verified' IS NOT NULL;

-- ── 4. Backfill billing section with camelCase keys ──
-- Frontend expects: { plan, status, trialEndsAt, subscriptionId, customerId, billingEmail, billingAddress: {...} }
UPDATE workspace_settings SET
  billing = jsonb_build_object(
    'plan', COALESCE(billing->>'plan', 'free'),
    'status', COALESCE(billing->>'status', 'active'),
    'trialEndsAt', billing->>'trialEndsAt',
    'subscriptionId', billing->>'subscript
    ionId',
    'customerId', billing->>'customerId',
    'billingEmail', billing->>'billingEmail',
    'billingAddress', COALESCE(billing->'billingAddress', jsonb_build_object(
      'line1', null, 'line2', null, 'city', null, 'state', null, 'postalCode', null, 'country', null
    ))
  )
WHERE billing->>'billingEmail' IS NULL
   OR billing->>'max_members' IS NOT NULL;

-- ── 5. Backfill limits section with camelCase keys ──
-- Frontend expects: { maxMembers, maxProjects, maxStorage, maxApiCallsPerDay, maxAiTokensPerDay, maxDocuments, maxSlides, maxNotes }
UPDATE workspace_settings SET
  limits = jsonb_build_object(
    'maxMembers', COALESCE((limits->>'max_members')::int, (limits->>'maxMembers')::int, 5),
    'maxProjects', COALESCE((limits->>'max_projects')::int, (limits->>'maxProjects')::int, 10),
    'maxStorage', COALESCE((limits->>'max_storage_bytes')::int, (limits->>'maxStorage')::int, 1073741824),
    'maxApiCallsPerDay', COALESCE((limits->>'max_api_calls_per_day')::int, (limits->>'maxApiCallsPerDay')::int, 1000),
    'maxAiTokensPerDay', COALESCE((limits->>'max_ai_tokens_per_day')::int, (limits->>'maxAiTokensPerDay')::int, 10000),
    'maxDocuments', COALESCE((limits->>'maxDocuments')::int, 100),
    'maxSlides', COALESCE((limits->>'maxSlides')::int, 500),
    'maxNotes', COALESCE((limits->>'maxNotes')::int, 500)
  )
WHERE limits->>'maxMembers' IS NULL
   OR limits->>'max_members' IS NOT NULL;

-- ── 6. Backfill ai section with camelCase keys ──
-- Frontend expects: { enabled, defaultModel, allowedModels, maxTokensPerDay, enableCodeExecution, enableWebSearch, enableFileUpload, privacyMode, trainingOptOut }
UPDATE workspace_settings SET
  ai = jsonb_build_object(
    'enabled', COALESCE((ai->>'enabled')::boolean, true),
    'defaultModel', COALESCE(ai->>'defaultModel', ai->>'default_model', 'gemini-2.5-flash'),
    'allowedModels', COALESCE(ai->'allowedModels', '["gemini-2.5-flash","gpt-4o","claude-3.5-sonnet"]'::jsonb),
    'maxTokensPerDay', COALESCE((ai->>'maxTokensPerDay')::int, (ai->>'max_tokens_per_day')::int, 10000),
    'enableCodeExecution', COALESCE((ai->>'enableCodeExecution')::boolean, true),
    'enableWebSearch', COALESCE((ai->>'enableWebSearch')::boolean, (ai->>'allow_external_web')::boolean, true),
    'enableFileUpload', COALESCE((ai->>'enableFileUpload')::boolean, true),
    'privacyMode', COALESCE((ai->>'privacyMode')::boolean, false),
    'trainingOptOut', COALESCE((ai->>'trainingOptOut')::boolean, (ai->>'allow_model_training')::boolean, false)
  )
WHERE ai->>'defaultModel' IS NULL
   OR ai->>'default_model' IS NOT NULL;

-- ── 7. Backfill notifications section with nested structure ──
-- Frontend expects: { enabled, channels: { email, inApp, push, slack }, events: { memberJoined, ... }, digest: { enabled, frequency, time, dayOfWeek } }
UPDATE workspace_settings SET
  notifications = jsonb_build_object(
    'enabled', COALESCE((notifications->>'enabled')::boolean, true),
    'channels', jsonb_build_object(
      'email', COALESCE((notifications->>'email_notifications')::boolean, (notifications->'channels'->>'email')::boolean, true),
      'inApp', COALESCE((notifications->>'in_app_enabled')::boolean, (notifications->'channels'->>'inApp')::boolean, true),
      'push', COALESCE((notifications->>'push_notifications')::boolean, (notifications->'channels'->>'push')::boolean, true),
      'slack', COALESCE((notifications->>'slack_enabled')::boolean, (notifications->'channels'->>'slack')::boolean, false)
    ),
    'events', jsonb_build_object(
      'memberJoined', COALESCE((notifications->>'member_joined')::boolean, (notifications->'events'->>'memberJoined')::boolean, true),
      'memberLeft', COALESCE((notifications->>'member_left')::boolean, (notifications->'events'->>'memberLeft')::boolean, true),
      'projectCreated', COALESCE((notifications->>'project_notifications')::boolean, (notifications->'events'->>'projectCreated')::boolean, true),
      'projectDeleted', COALESCE((notifications->>'project_deleted')::boolean, (notifications->'events'->>'projectDeleted')::boolean, true),
      'taskCompleted', COALESCE((notifications->>'task_notifications')::boolean, (notifications->'events'->>'taskCompleted')::boolean, true),
      'mentions', COALESCE((notifications->>'mention_notifications')::boolean, (notifications->'events'->>'mentions')::boolean, true)
    ),
    'digest', jsonb_build_object(
      'enabled', COALESCE((notifications->>'digest_enabled')::boolean, (notifications->'digest'->>'enabled')::boolean, true),
      'frequency', COALESCE(notifications->>'digest_frequency', notifications->'digest'->>'frequency', 'daily'),
      'time', COALESCE(notifications->>'digest_time', notifications->'digest'->>'time', '09:00'),
      'dayOfWeek', COALESCE((notifications->>'day_of_week')::int, (notifications->'digest'->>'dayOfWeek')::int, 1)
    )
  )
WHERE notifications->'channels' IS NULL
   OR notifications->>'email_notifications' IS NOT NULL;

-- ── 8. Backfill security section with camelCase keys ──
-- Frontend expects: { twoFactorRequired, sessionTimeout, dataRetentionDays, ipWhitelist, allowedCountries, blockedCountries, requirePasswordForSensitive, auditLogEnabled }
UPDATE workspace_settings SET
  security = jsonb_build_object(
    'twoFactorRequired', COALESCE((security->>'twoFactorRequired')::boolean, (security->>'require_2fa')::boolean, false),
    'sessionTimeout', COALESCE((security->>'sessionTimeout')::int, (security->>'session_timeout')::int, 30),
    'dataRetentionDays', COALESCE((security->>'dataRetentionDays')::int, (security->>'data_retention_days')::int, 90),
    'ipWhitelist', COALESCE(security->'ipWhitelist', security->'ip_whitelist', '[]'::jsonb),
    'allowedCountries', COALESCE(security->'allowedCountries', security->'allowed_countries', '[]'::jsonb),
    'blockedCountries', COALESCE(security->'blockedCountries', security->'blocked_countries', '[]'::jsonb),
    'requirePasswordForSensitive', COALESCE((security->>'requirePasswordForSensitive')::boolean, false),
    'auditLogEnabled', COALESCE((security->>'auditLogEnabled')::boolean, true)
  )
WHERE security->>'twoFactorRequired' IS NULL
   OR security->>'require_2fa' IS NOT NULL;

-- ── 9. Backfill access section with camelCase keys ──
-- Frontend expects: { publicRead, publicWrite, allowGuestComments, inviteOnly, domainRestriction, ssoEnabled, ssoProvider }
UPDATE workspace_settings SET
  access = jsonb_build_object(
    'publicRead', COALESCE((access->>'publicRead')::boolean, (access->>'public_sharing')::boolean, false),
    'publicWrite', COALESCE((access->>'publicWrite')::boolean, false),
    'allowGuestComments', COALESCE((access->>'allowGuestComments')::boolean, (access->>'guest_access')::boolean, false),
    'inviteOnly', COALESCE((access->>'inviteOnly')::boolean, false),
    'domainRestriction', COALESCE(access->>'domainRestriction', access->>'domain_restriction', null),
    'ssoEnabled', COALESCE((access->>'ssoEnabled')::boolean, false),
    'ssoProvider', COALESCE(access->>'ssoProvider', null)
  )
WHERE access->>'publicRead' IS NULL
   OR access->>'allow_member_invites' IS NOT NULL;
