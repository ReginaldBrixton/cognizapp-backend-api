-- 068_support_file_edit_delete_audit.sql
-- Track provider-side support file replacements and soft deletes.

ALTER TABLE support_files
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT,
  ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replaced_by TEXT,
  ADD COLUMN IF NOT EXISTS previous_file_name TEXT;

CREATE INDEX IF NOT EXISTS idx_support_files_active_request
  ON support_files(request_id, created_at)
  WHERE deleted_at IS NULL;
