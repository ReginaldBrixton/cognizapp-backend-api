-- 002_advanced.sql
-- Additive enhancements: new tables + new columns on existing tables
-- All operations are idempotent (IF NOT EXISTS / DO $$ ... END $$)

-- ─── 1. New columns on auth.users ───────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'personal';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'free';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN subscription_expires_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN onboarding_step TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN last_workspace_id UUID;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN storage_tier TEXT NOT NULL DEFAULT 'free';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN storage_quota_bytes BIGINT NOT NULL DEFAULT 5368709120;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN storage_used_bytes BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auth.users ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ─── 2. auth.notifications ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth.notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,

    -- Content
    type            TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'general',
    title           TEXT NOT NULL,
    body            TEXT,
    action_url      TEXT,

    -- Related entity
    entity_type     TEXT,
    entity_id       TEXT,

    -- Who triggered it
    actor_id        UUID REFERENCES auth.users(id),
    actor_name      TEXT,
    actor_avatar    TEXT,

    -- Status
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    read_at         TIMESTAMPTZ,
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at     TIMESTAMPTZ,
    is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
    priority        TEXT NOT NULL DEFAULT 'normal',

    -- Delivery tracking
    delivered_email   BOOLEAN NOT NULL DEFAULT FALSE,
    delivered_push    BOOLEAN NOT NULL DEFAULT FALSE,
    delivered_in_app  BOOLEAN NOT NULL DEFAULT TRUE,

    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id   ON auth.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread    ON auth.notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON auth.notifications(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_type      ON auth.notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_created   ON auth.notifications(created_at DESC);

-- ─── 3. workspace_daily_stats ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspace_daily_stats (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    date                 DATE NOT NULL,
    new_members          INTEGER NOT NULL DEFAULT 0,
    active_members       INTEGER NOT NULL DEFAULT 0,
    new_projects         INTEGER NOT NULL DEFAULT 0,
    new_tasks            INTEGER NOT NULL DEFAULT 0,
    completed_tasks      INTEGER NOT NULL DEFAULT 0,
    new_conversations    INTEGER NOT NULL DEFAULT 0,
    ai_tokens_used       INTEGER NOT NULL DEFAULT 0,
    api_calls            INTEGER NOT NULL DEFAULT 0,
    storage_delta_bytes  BIGINT NOT NULL DEFAULT 0,
    activity_score       INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_workspace ON workspace_daily_stats(workspace_id);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date      ON workspace_daily_stats(workspace_id, date DESC);

-- ─── 4. Additional workspace columns ─────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE workspaces ADD COLUMN is_template BOOLEAN NOT NULL DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspaces ADD COLUMN clone_count INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspaces ADD COLUMN last_backup_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ─── 5. workspace_settings extra columns ─────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE workspace_settings ADD COLUMN appearance JSONB NOT NULL DEFAULT '{}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspace_settings ADD COLUMN features JSONB NOT NULL DEFAULT '{"enabled":["projects","collections","chat","automations"],"disabled":[]}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspace_settings ADD COLUMN billing JSONB NOT NULL DEFAULT '{"plan":"free","max_members":5,"max_projects":10,"max_storage_bytes":5368709120,"max_api_calls_per_day":1000,"max_ai_tokens_per_day":100000}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ─── 6. user_settings extra column ───────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE user_settings ADD COLUMN ai JSONB NOT NULL DEFAULT '{}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
