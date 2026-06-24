CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspaces_owner_deleted
  ON app.workspaces(owner_uid, deleted_at);

DROP INDEX CONCURRENTLY IF EXISTS app.idx_workspaces_deleted;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspaces_deleted
  ON app.workspaces(deleted_at)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspace_members_user_deleted
  ON app.workspace_members(user_uid, deleted_at);

DROP INDEX CONCURRENTLY IF EXISTS app.idx_workspace_members_workspace_deleted;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspace_members_ws_deleted
  ON app.workspace_members(workspace_id, deleted_at);

DROP INDEX CONCURRENTLY IF EXISTS app.idx_workspace_activity_workspace_created_desc;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspace_activity_ws_created
  ON app.workspace_activity(workspace_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS app.idx_workspace_activity_workspace_created;
