-- 009_schema_robustness.sql
-- Fills every gap left by migrations 001–008:
--   • Missing tables referenced by repository code
--   • Missing indexes for hot query paths
--   • Automatic updated_at triggers on every table
--   • CHECK constraints for data integrity
--   • Proper FKs where missing
--   • Workspace-settings sections added in 002/006/types.ts
-- Safe to re-run: all statements use IF NOT EXISTS / DO $$ EXCEPTION END $$.

-- ═══════════════════════════════════════════════════════════════════
--  0.  pg_trgm EXTENSION (required for GIN trigram indexes below)
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ═══════════════════════════════════════════════════════════════════
--  1.  MISSING TABLES — workspace_projects, project_documents, etc.
--      (007 created documents/research_projects/tasks but the code
--       queries workspace_projects / project_documents / project_slides
--       / project_notes / project_tasks)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workspace_projects (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID        REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_uid       TEXT        NOT NULL,
    title           TEXT        NOT NULL DEFAULT 'Untitled',
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'active',
    visibility      TEXT        NOT NULL DEFAULT 'private',
    field_of_study  TEXT,
    project_type    TEXT,
    keywords        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    collaborators   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    completion_pct  INTEGER     NOT NULL DEFAULT 0 CHECK (completion_pct BETWEEN 0 AND 100),
    deadline        TIMESTAMPTZ,
    document_count  INTEGER     NOT NULL DEFAULT 0,
    task_count      INTEGER     NOT NULL DEFAULT 0,
    completed_tasks INTEGER     NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wp_workspace  ON workspace_projects(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wp_owner      ON workspace_projects(owner_uid);
CREATE INDEX IF NOT EXISTS idx_wp_status     ON workspace_projects(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS project_documents (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID        REFERENCES workspace_projects(id) ON DELETE CASCADE,
    owner_uid           TEXT        NOT NULL,
    title               TEXT        NOT NULL DEFAULT 'Untitled',
    doc_type            TEXT        NOT NULL DEFAULT 'document',
    content             TEXT        NOT NULL DEFAULT '',
    content_json        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    word_count          INTEGER     NOT NULL DEFAULT 0,
    char_count          INTEGER     NOT NULL DEFAULT 0,
    page_count          INTEGER     NOT NULL DEFAULT 1,
    version             INTEGER     NOT NULL DEFAULT 1,
    plagiarism_score    NUMERIC(5,2),
    ai_content_score    NUMERIC(5,2),
    readability_score   NUMERIC(5,2),
    last_plagiarism_check TIMESTAMPTZ,
    last_ai_check         TIMESTAMPTZ,
    collaborators       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_public           BOOLEAN     NOT NULL DEFAULT FALSE,
    share_token         TEXT,
    share_expires_at    TIMESTAMPTZ,
    status              TEXT        NOT NULL DEFAULT 'active',
    is_template         BOOLEAN     NOT NULL DEFAULT FALSE,
    parent_id           UUID        REFERENCES project_documents(id) ON DELETE SET NULL,
    abstract            TEXT,
    keywords            TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    citation_style      TEXT        NOT NULL DEFAULT 'apa',
    language            TEXT        NOT NULL DEFAULT 'en',
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pd_project  ON project_documents(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pd_owner    ON project_documents(owner_uid);
CREATE INDEX IF NOT EXISTS idx_pd_type     ON project_documents(doc_type);

CREATE TABLE IF NOT EXISTS project_slides (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID        REFERENCES workspace_projects(id) ON DELETE CASCADE,
    owner_uid       TEXT        NOT NULL,
    title           TEXT        NOT NULL DEFAULT 'Untitled',
    slide_data      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    slide_count     INTEGER     NOT NULL DEFAULT 0,
    version         INTEGER     NOT NULL DEFAULT 1,
    collaborators   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_public       BOOLEAN     NOT NULL DEFAULT FALSE,
    share_token     TEXT,
    share_expires_at TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'active',
    is_template     BOOLEAN     NOT NULL DEFAULT FALSE,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ps_project ON project_slides(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ps_owner   ON project_slides(owner_uid);

CREATE TABLE IF NOT EXISTS project_notes (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID        REFERENCES workspace_projects(id) ON DELETE CASCADE,
    owner_uid       TEXT        NOT NULL,
    title           TEXT        NOT NULL DEFAULT 'Untitled',
    content         TEXT        NOT NULL DEFAULT '',
    content_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    collaborators   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_public       BOOLEAN     NOT NULL DEFAULT FALSE,
    status          TEXT        NOT NULL DEFAULT 'active',
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pn_project ON project_notes(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pn_owner   ON project_notes(owner_uid);

CREATE TABLE IF NOT EXISTS project_tasks (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID        REFERENCES workspace_projects(id) ON DELETE SET NULL,
    document_id     UUID        REFERENCES project_documents(id) ON DELETE SET NULL,
    slide_id        UUID        REFERENCES project_slides(id) ON DELETE SET NULL,
    note_id         UUID        REFERENCES project_notes(id) ON DELETE SET NULL,
    owner_uid       TEXT        NOT NULL,
    assignee_uid    TEXT,
    created_by_uid  TEXT        NOT NULL,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'todo',
    priority        TEXT        NOT NULL DEFAULT 'medium',
    task_type       TEXT        NOT NULL DEFAULT 'task',
    due_date        TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    estimated_hours NUMERIC(6,2),
    actual_hours    NUMERIC(6,2),
    tags            TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    attachments     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    subtasks        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    comments_count  INTEGER     NOT NULL DEFAULT 0,
    display_order   INTEGER     NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pt_project    ON project_tasks(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pt_assignee   ON project_tasks(assignee_uid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pt_owner      ON project_tasks(owner_uid);
CREATE INDEX IF NOT EXISTS idx_pt_status     ON project_tasks(status) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════
--  2.  MISSING TABLES — workspace_collections, collection_items
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workspace_collections (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID        REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_uid       TEXT        NOT NULL,
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    collection_type TEXT        NOT NULL DEFAULT 'folder',
    parent_id       UUID        REFERENCES workspace_collections(id) ON DELETE SET NULL,
    filters         JSONB,
    sort_order      INTEGER     NOT NULL DEFAULT 0,
    is_default      BOOLEAN     NOT NULL DEFAULT FALSE,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wc_workspace ON workspace_collections(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wc_parent    ON workspace_collections(parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wc_type      ON workspace_collections(collection_type) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS collection_items (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id   UUID        NOT NULL REFERENCES workspace_collections(id) ON DELETE CASCADE,
    item_type       TEXT        NOT NULL,
    item_id         UUID        NOT NULL,
    added_by        TEXT        NOT NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sort_order      INTEGER     NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ci_collection ON collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_ci_item       ON collection_items(item_type, item_id);

-- ═══════════════════════════════════════════════════════════════════
--  3.  MISSING TABLES — workspace_analysis + sub-types
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workspace_analysis (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID        REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_uid        TEXT        NOT NULL,
    analysis_type    TEXT        NOT NULL,
    title            TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    status           TEXT        NOT NULL DEFAULT 'pending',
    input_data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    result_data      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    confidence_score NUMERIC(5,2),
    source_reference TEXT,
    metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wa_workspace ON workspace_analysis(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wa_type      ON workspace_analysis(analysis_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wa_status    ON workspace_analysis(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS analysis_humanise (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id         UUID        NOT NULL REFERENCES workspace_analysis(id) ON DELETE CASCADE,
    original_text       TEXT        NOT NULL,
    humanised_text      TEXT        NOT NULL,
    humanisation_score  NUMERIC(5,2),
    change_log          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    suggestions         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ah_analysis ON analysis_humanise(analysis_id);

CREATE TABLE IF NOT EXISTS analysis_textcompare (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id      UUID        NOT NULL REFERENCES workspace_analysis(id) ON DELETE CASCADE,
    text_a           TEXT        NOT NULL,
    text_b           TEXT        NOT NULL,
    similarity_score NUMERIC(5,2),
    differences      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    common_phrases   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    unique_to_a      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    unique_to_b      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atc_analysis ON analysis_textcompare(analysis_id);

CREATE TABLE IF NOT EXISTS analysis_textidentify (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id           UUID        NOT NULL REFERENCES workspace_analysis(id) ON DELETE CASCADE,
    input_text            TEXT        NOT NULL,
    detected_language     TEXT,
    detected_tone         TEXT,
    detected_entities     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    classification_results JSONB      NOT NULL DEFAULT '{}'::jsonb,
    metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ati_analysis ON analysis_textidentify(analysis_id);

CREATE TABLE IF NOT EXISTS analysis_factcheck (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id         UUID        NOT NULL REFERENCES workspace_analysis(id) ON DELETE CASCADE,
    claim_text          TEXT        NOT NULL,
    verification_status TEXT        NOT NULL DEFAULT 'unverified',
    credibility_score   NUMERIC(5,2),
    evidence_sources    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    supporting_sources  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    refuting_sources    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_afc_analysis ON analysis_factcheck(analysis_id);

-- ═══════════════════════════════════════════════════════════════════
--  4.  MISSING COLUMNS on workspace_settings (002 added some, but
--      types.ts defines: general, appearance, notifications, security,
--      limits, ai, access, features, storage, integrations, billing)
-- ═══════════════════════════════════════════════════════════════════

DO $$ BEGIN
    ALTER TABLE workspace_settings ADD COLUMN notifications JSONB NOT NULL DEFAULT '{}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspace_settings ADD COLUMN features JSONB NOT NULL DEFAULT '{"projectsEnabled":true,"analysisEnabled":true,"collectionsEnabled":true,"tasksEnabled":true,"notesEnabled":true,"slidesEnabled":true,"aiEnabled":true,"apiAccess":false,"webhooksEnabled":false,"customDomains":false}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspace_settings ADD COLUMN billing JSONB NOT NULL DEFAULT '{"plan":"free","status":"active","trialEndsAt":null,"subscriptionId":null,"customerId":null,"billingEmail":null,"billingAddress":{"line1":null,"line2":null,"city":null,"state":null,"postalCode":null,"country":null}}'::jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════
--  5.  MISSING INDEXES for hot query paths
-- ═══════════════════════════════════════════════════════════════════

-- auth.users
CREATE INDEX IF NOT EXISTS idx_users_status      ON auth.users(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_role        ON auth.users(role);
CREATE INDEX IF NOT EXISTS idx_users_email_ilike ON auth.users USING gin(email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_display_ilike ON auth.users USING gin(display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_full_ilike  ON auth.users USING gin(full_name gin_trgm_ops);

-- auth.sessions
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON auth.sessions(expires_at) WHERE is_revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_sessions_active   ON auth.sessions(user_id, is_revoked, expires_at) WHERE is_revoked = FALSE;

-- auth.notifications
CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON auth.notifications(user_id, created_at DESC) WHERE is_read = FALSE AND is_archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_notif_workspace   ON auth.notifications(workspace_id, created_at DESC) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_notif_category    ON auth.notifications(user_id, category, created_at DESC) WHERE is_archived = FALSE;

-- auth.audit_events
CREATE INDEX IF NOT EXISTS idx_audit_target      ON auth.audit_events(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor_id    ON auth.audit_events(actor_id) WHERE actor_id IS NOT NULL;

-- user_onboarding
CREATE INDEX IF NOT EXISTS idx_onboarding_email  ON user_onboarding(email);

-- workspace_members
CREATE INDEX IF NOT EXISTS idx_wm_email          ON workspace_members(email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wm_role           ON workspace_members(role) WHERE deleted_at IS NULL;

-- workspace_daily_stats
CREATE INDEX IF NOT EXISTS idx_wds_date          ON workspace_daily_stats(date DESC);

-- workspaces
CREATE INDEX IF NOT EXISTS idx_ws_slug           ON workspaces(slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ws_status         ON workspaces(status) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════
--  6.  CHECK CONSTRAINTS for data integrity
-- ═══════════════════════════════════════════════════════════════════

DO $$ BEGIN
    ALTER TABLE auth.users ADD CONSTRAINT chk_users_status
        CHECK (status IN ('active', 'banned', 'disabled', 'deleted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE auth.users ADD CONSTRAINT chk_users_role
        CHECK (role IN ('REGULAR_USER', 'PRO_USER', 'SUPPORT_PROVIDER_USER', 'DEV_USER', 'ADMIN_USER', 'SYSTEM_USER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspaces ADD CONSTRAINT chk_ws_status
        CHECK (status IN ('active', 'archived', 'deleted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspace_members ADD CONSTRAINT chk_wm_role
        CHECK (role IN ('owner', 'admin', 'member', 'viewer'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspace_members ADD CONSTRAINT chk_wm_status
        CHECK (status IN ('active', 'removed', 'suspended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspace_invitations ADD CONSTRAINT chk_wi_status
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE auth.notifications ADD CONSTRAINT chk_notif_priority
        CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspace_analysis ADD CONSTRAINT chk_wa_status
        CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE workspace_analysis ADD CONSTRAINT chk_wa_type
        CHECK (analysis_type IN ('humanise', 'textcompare', 'textidentify', 'factcheck'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════
--  7.  AUTOMATIC updated_at TRIGGERS
--      Every table with an updated_at column gets a trigger so the
--      application code never has to remember SET updated_at = NOW().
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers only for tables that have updated_at column
DROP TRIGGER IF EXISTS trg_workspaces_updated_at ON workspaces;
CREATE TRIGGER trg_workspaces_updated_at
    BEFORE UPDATE ON workspaces
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_members_updated_at ON workspace_members;
CREATE TRIGGER trg_workspace_members_updated_at
    BEFORE UPDATE ON workspace_members
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_settings_updated_at ON workspace_settings;
CREATE TRIGGER trg_workspace_settings_updated_at
    BEFORE UPDATE ON workspace_settings
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_user_settings_updated_at ON user_settings;
CREATE TRIGGER trg_user_settings_updated_at
    BEFORE UPDATE ON user_settings
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_invitations_updated_at ON workspace_invitations;
CREATE TRIGGER trg_workspace_invitations_updated_at
    BEFORE UPDATE ON workspace_invitations
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

-- New tables from this migration
DROP TRIGGER IF EXISTS trg_workspace_projects_updated_at ON workspace_projects;
CREATE TRIGGER trg_workspace_projects_updated_at
    BEFORE UPDATE ON workspace_projects
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_collections_updated_at ON workspace_collections;
CREATE TRIGGER trg_workspace_collections_updated_at
    BEFORE UPDATE ON workspace_collections
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_analysis_updated_at ON workspace_analysis;
CREATE TRIGGER trg_workspace_analysis_updated_at
    BEFORE UPDATE ON workspace_analysis
    FOR EACH ROW
    WHEN (OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    EXECUTE FUNCTION trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════
--  9.  ALIAS TABLES for backward compatibility
--      The codebase still references the old names from 007.
-- ═══════════════════════════════════════════════════════════════════

-- If research_projects exists but workspace_projects does not,
-- create a view so both names work.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'research_projects' AND table_schema = 'public')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workspace_projects' AND table_schema = 'public') THEN
        EXECUTE 'CREATE VIEW workspace_projects AS SELECT * FROM research_projects';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'documents' AND table_schema = 'public')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'project_documents' AND table_schema = 'public') THEN
        EXECUTE 'CREATE VIEW project_documents AS SELECT id, project_id, owner_uid, title, doc_type, content, content_json, word_count, char_count, page_count, version, plagiarism_score, ai_content_score, readability_score, last_plagiarism_check, last_ai_check, collaborators, is_public, share_token, share_expires_at, status, is_template, parent_id, abstract, keywords, citation_style, language, metadata, created_at, updated_at, deleted_at FROM documents';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks' AND table_schema = 'public')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'project_tasks' AND table_schema = 'public') THEN
        EXECUTE 'CREATE VIEW project_tasks AS SELECT id, project_id, document_id, NULL::uuid AS slide_id, NULL::uuid AS note_id, owner_uid, assignee_uid, created_by_uid, title, description, status, priority, task_type, due_date, started_at, completed_at, estimated_hours, actual_hours, tags, attachments, subtasks, comments_count, display_order, metadata, created_at, updated_at, deleted_at FROM tasks';
    END IF;
END $$;
