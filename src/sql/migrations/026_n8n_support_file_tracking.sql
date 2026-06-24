-- 026_n8n_support_file_tracking.sql
-- Tracks Google Drive folder/file IDs returned by n8n webhooks while keeping
-- app text/status data in Neon.

ALTER TABLE support_requests
    ADD COLUMN IF NOT EXISTS drive_folder_id TEXT,
    ADD COLUMN IF NOT EXISTS drive_folder_url TEXT,
    ADD COLUMN IF NOT EXISTS drive_folder_path TEXT,
    ADD COLUMN IF NOT EXISTS drive_folder_status TEXT NOT NULL DEFAULT 'not_requested',
    ADD COLUMN IF NOT EXISTS drive_folder_error TEXT,
    ADD COLUMN IF NOT EXISTS drive_folder_synced_at TIMESTAMPTZ;

ALTER TABLE support_files
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'database',
    ADD COLUMN IF NOT EXISTS external_file_id TEXT,
    ADD COLUMN IF NOT EXISTS external_file_url TEXT,
    ADD COLUMN IF NOT EXISTS external_folder_id TEXT,
    ADD COLUMN IF NOT EXISTS external_upload_status TEXT NOT NULL DEFAULT 'stored_locally',
    ADD COLUMN IF NOT EXISTS external_upload_error TEXT,
    ADD COLUMN IF NOT EXISTS external_uploaded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_support_requests_drive_folder
    ON support_requests(drive_folder_id)
    WHERE drive_folder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_files_external_file
    ON support_files(external_file_id)
    WHERE external_file_id IS NOT NULL;
