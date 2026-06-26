-- 074_voice_notes.sql
-- Add voice note support to support_files.
-- Users can record and attach voice notes to support requests,
-- which are stored as audio files with duration metadata.

ALTER TABLE support_files
    ADD COLUMN IF NOT EXISTS is_voice_note BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE support_files
    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

-- Index to quickly filter voice notes for a request
CREATE INDEX IF NOT EXISTS idx_support_files_voice_notes
    ON support_files (request_id) WHERE is_voice_note = TRUE;
