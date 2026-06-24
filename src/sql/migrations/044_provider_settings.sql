-- Provider-owned settings for the Provider portal.
-- Target: cognizap database, app schema.

CREATE TABLE IF NOT EXISTS provider_settings (
  provider_key_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Africa/Accra',
  availability_status TEXT NOT NULL DEFAULT 'available'
    CHECK (availability_status IN ('available', 'busy', 'away', 'offline')),
  weekly_capacity INTEGER NOT NULL DEFAULT 20
    CHECK (weekly_capacity BETWEEN 0 AND 168),
  response_target_hours INTEGER NOT NULL DEFAULT 24
    CHECK (response_target_hours BETWEEN 1 AND 168),
  notification_preferences JSONB NOT NULL DEFAULT
    '{"email":true,"newRequests":true,"messages":true,"deadlineReminders":true}'::jsonb,
  workload_preferences JSONB NOT NULL DEFAULT
    '{"preferredServices":[],"maxActiveRequests":10,"autoAssign":false}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_settings_availability
  ON provider_settings(availability_status, updated_at DESC);

DROP TRIGGER IF EXISTS trg_provider_settings_updated_at ON provider_settings;
CREATE TRIGGER trg_provider_settings_updated_at
BEFORE UPDATE ON provider_settings
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
