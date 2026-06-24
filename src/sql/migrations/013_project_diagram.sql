-- 013_project_diagram.sql
-- Adds the missing project_diagrams table for diagram module

CREATE TABLE IF NOT EXISTS project_diagrams (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID        REFERENCES workspace_projects(id) ON DELETE CASCADE,
    owner_uid       TEXT        NOT NULL,
    title           TEXT        NOT NULL DEFAULT 'Untitled',
    diagram_type    TEXT        NOT NULL DEFAULT 'mermaid',
    diagram_data    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    version         INTEGER     NOT NULL DEFAULT 1,
    collaborators   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_public       BOOLEAN     NOT NULL DEFAULT FALSE,
    share_token     TEXT,
    share_expires_at TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'active',
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pdiag_project ON project_diagrams(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pdiag_owner   ON project_diagrams(owner_uid);