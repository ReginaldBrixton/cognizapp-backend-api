-- 007_research_platform.sql
-- Core research-platform tables: documents, research_projects, tasks
-- These back the Google-Docs-like writing interface, spreadsheets,
-- presentations, plagiarism/AI scans, and task management.

-- ── Documents ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID        REFERENCES workspaces(id) ON DELETE SET NULL,
    owner_uid           TEXT        NOT NULL,
    title               TEXT        NOT NULL DEFAULT 'Untitled',
    doc_type            TEXT        NOT NULL DEFAULT 'document',
    -- 'document' | 'spreadsheet' | 'presentation' | 'note' | 'bibliography'

    content             TEXT        NOT NULL DEFAULT '',
    content_json        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- structured Tiptap/ProseMirror JSON for the editor

    word_count          INTEGER     NOT NULL DEFAULT 0,
    char_count          INTEGER     NOT NULL DEFAULT 0,
    page_count          INTEGER     NOT NULL DEFAULT 1,
    version             INTEGER     NOT NULL DEFAULT 1,

    -- AI / research quality scores (0.00–1.00)
    plagiarism_score    NUMERIC(5,2),   -- null = not yet scanned
    ai_content_score    NUMERIC(5,2),   -- null = not yet scanned
    readability_score   NUMERIC(5,2),

    last_plagiarism_check TIMESTAMPTZ,
    last_ai_check         TIMESTAMPTZ,

    -- Collaboration
    collaborators       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- array of user UIDs with at least read access

    -- Access control
    is_public           BOOLEAN     NOT NULL DEFAULT FALSE,
    share_token         TEXT,
    share_expires_at    TIMESTAMPTZ,

    -- Lifecycle
    status              TEXT        NOT NULL DEFAULT 'active',
    -- 'active' | 'archived' | 'trashed'
    is_template         BOOLEAN     NOT NULL DEFAULT FALSE,
    parent_id           UUID        REFERENCES documents(id) ON DELETE SET NULL,
    -- for nested/sub-documents

    -- Research metadata
    abstract            TEXT,
    keywords            TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    citation_style      TEXT        NOT NULL DEFAULT 'apa',
    -- 'apa' | 'mla' | 'chicago' | 'ieee' | 'harvard'
    language            TEXT        NOT NULL DEFAULT 'en',
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_documents_owner     ON documents(owner_uid);
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_type      ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_status    ON documents(status) WHERE deleted_at IS NULL;

-- ── Research projects ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS research_projects (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID        REFERENCES workspaces(id) ON DELETE SET NULL,
    owner_uid       TEXT        NOT NULL,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'active',
    -- 'active' | 'completed' | 'paused' | 'archived'
    visibility      TEXT        NOT NULL DEFAULT 'private',
    -- 'private' | 'workspace' | 'public'

    field_of_study  TEXT,
    research_type   TEXT,
    -- 'qualitative' | 'quantitative' | 'mixed' | 'review' | 'meta_analysis'
    keywords        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    collaborators   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Progress
    completion_pct  INTEGER     NOT NULL DEFAULT 0 CHECK (completion_pct BETWEEN 0 AND 100),
    deadline        TIMESTAMPTZ,

    -- Stats (denormalised for fast dashboard queries)
    document_count  INTEGER     NOT NULL DEFAULT 0,
    task_count      INTEGER     NOT NULL DEFAULT 0,
    completed_tasks INTEGER     NOT NULL DEFAULT 0,

    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_research_projects_owner     ON research_projects(owner_uid);
CREATE INDEX IF NOT EXISTS idx_research_projects_workspace ON research_projects(workspace_id);

-- ── Tasks ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID        REFERENCES workspaces(id) ON DELETE SET NULL,
    project_id      UUID        REFERENCES research_projects(id) ON DELETE SET NULL,
    document_id     UUID        REFERENCES documents(id) ON DELETE SET NULL,
    owner_uid       TEXT        NOT NULL,
    assignee_uid    TEXT,
    created_by_uid  TEXT        NOT NULL,

    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'todo',
    -- 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'
    priority        TEXT        NOT NULL DEFAULT 'medium',
    -- 'low' | 'medium' | 'high' | 'urgent'
    task_type       TEXT        NOT NULL DEFAULT 'task',
    -- 'task' | 'milestone' | 'review' | 'research' | 'writing'

    due_date        TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    estimated_hours NUMERIC(6,2),
    actual_hours    NUMERIC(6,2),

    tags            TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    attachments     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    subtasks        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- embedded array of {id, title, done} for lightweight sub-tasks
    comments_count  INTEGER     NOT NULL DEFAULT 0,

    display_order   INTEGER     NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_owner     ON tasks(owner_uid);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee  ON tasks(assignee_uid);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status) WHERE deleted_at IS NULL;
