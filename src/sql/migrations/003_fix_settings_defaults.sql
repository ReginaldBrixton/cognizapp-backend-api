-- 003_fix_settings_defaults.sql
-- Backfill all existing user_settings rows that still have empty JSONB sections
-- Safe to re-run: only updates rows where the section equals '{}'

UPDATE user_settings SET
  account = '{"locale":"en","timezone":"UTC","email_verified":false,"phone_verified":false,"status":"active"}'::jsonb
WHERE account = '{}'::jsonb;

UPDATE user_settings SET
  profile = jsonb_build_object('full_name', COALESCE(full_name,''), 'display_name', COALESCE(full_name,''), 'avatar_url', COALESCE(avatar_url,''), 'account_type', 'personal')
WHERE profile = '{}'::jsonb;

UPDATE user_settings SET
  appearance = '{"theme":"system","color_scheme":"default","accent_color":"#6366f1","font_size":"medium","font_family":"system","density":"comfortable","layout":"default","sidebar_collapsed":false,"reduce_motion":false}'::jsonb
WHERE appearance = '{}'::jsonb;

UPDATE user_settings SET
  notifications = '{"email_enabled":true,"push_enabled":true,"in_app_enabled":true,"desktop_enabled":false,"sound_enabled":true,"digest_frequency":"daily","mention_notify":true,"task_assign_notify":true,"project_update_notify":true,"marketing_notify":false,"research_updates":true,"collaboration_invites":true,"system_alerts":true,"dnd_enabled":false,"quiet_hours":{"enabled":false,"start":"22:00","end":"08:00","timezone":"UTC"},"digest_time":"09:00","sound_volume":80}'::jsonb
WHERE notifications = '{}'::jsonb;

UPDATE user_settings SET
  preferences = '{"default_landing":"workspace","keyboard_shortcuts":true,"auto_save":true,"show_welcome_tips":true,"date_format":"MM/DD/YYYY","time_format":"12h","first_day_of_week":0,"units":"metric","recent_items_limit":10,"open_last_workspace_on_login":true}'::jsonb
WHERE preferences = '{}'::jsonb;

UPDATE user_settings SET
  security = '{"two_factor_enabled":false,"session_timeout_minutes":10080,"login_notifications":true,"recovery_codes_generated":false}'::jsonb
WHERE security = '{}'::jsonb;

UPDATE user_settings SET
  onboarding = '{"completed":false,"steps_done":[],"current_step":null}'::jsonb
WHERE onboarding = '{}'::jsonb;

UPDATE user_settings SET
  privacy = '{"telemetry_enabled":true,"crash_reports_enabled":true,"ai_training_opt_out":false,"data_retention_days":90}'::jsonb
WHERE privacy = '{}'::jsonb;

UPDATE user_settings SET
  storage = '{"tier":"free","quota_bytes":5368709120,"used_bytes":0}'::jsonb
WHERE storage = '{}'::jsonb;

UPDATE user_settings SET
  ai = '{"model":"auto","temperature":0.7,"stream_responses":true,"auto_suggestions":true,"allow_external_web":true,"data_retention_days":30,"allow_model_training":false,"citation_required":true}'::jsonb
WHERE ai = '{}'::jsonb;

-- Ensure workspace_settings also have proper features/billing/appearance if missing
UPDATE workspace_settings SET
  features = '{"enabled":["projects","collections","chat","automations"],"disabled":[]}'::jsonb
WHERE features = '{}'::jsonb OR features IS NULL;

UPDATE workspace_settings SET
  billing = '{"plan":"free","max_members":5,"max_projects":10,"max_storage_bytes":5368709120,"max_api_calls_per_day":1000,"max_ai_tokens_per_day":100000}'::jsonb
WHERE billing = '{}'::jsonb OR billing IS NULL;

UPDATE workspace_settings SET
  appearance = '{"theme":"system","language":"en","date_format":"MM/DD/YYYY","time_zone":"UTC"}'::jsonb
WHERE appearance = '{}'::jsonb OR appearance IS NULL;
