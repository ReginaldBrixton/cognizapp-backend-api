CREATE TABLE IF NOT EXISTS project_document_comments (
    id          TEXT        PRIMARY KEY,
    document_id UUID        NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
    project_id  UUID        NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
    user_id     TEXT        NOT NULL,
    body        TEXT        NOT NULL DEFAULT '',
    anchor      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    resolved    BOOLEAN     NOT NULL DEFAULT FALSE,
    replies     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pdc_document
    ON project_document_comments(document_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pdc_project
    ON project_document_comments(project_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pdc_user
    ON project_document_comments(user_id)
    WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_project_document_comments_updated_at ON project_document_comments;
CREATE TRIGGER trg_project_document_comments_updated_at
    BEFORE UPDATE ON project_document_comments
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_updated_at();
