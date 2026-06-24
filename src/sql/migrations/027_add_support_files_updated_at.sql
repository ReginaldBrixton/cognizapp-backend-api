-- 027_add_support_files_updated_at.sql

ALTER TABLE support_files
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
