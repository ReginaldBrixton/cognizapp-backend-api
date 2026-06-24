-- 050_protected_preview_flow.sql
-- Free submission, protected preview assets, risk snapshots, and payment-policy locking.

ALTER TABLE support_clients
    ADD COLUMN IF NOT EXISTS risk_tier_override TEXT,
    ADD COLUMN IF NOT EXISTS risk_override_reason TEXT,
    ADD COLUMN IF NOT EXISTS risk_override_by TEXT,
    ADD COLUMN IF NOT EXISTS risk_override_at TIMESTAMPTZ;

ALTER TABLE support_requests
    ADD COLUMN IF NOT EXISTS risk_tier TEXT NOT NULL DEFAULT 'first_time',
    ADD COLUMN IF NOT EXISTS payment_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS payment_policy_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS preview_status TEXT NOT NULL DEFAULT 'not_started',
    ADD COLUMN IF NOT EXISTS preview_access TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS revisions_allowed INTEGER NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS revisions_used INTEGER NOT NULL DEFAULT 0;

ALTER TABLE support_deliveries
    ADD COLUMN IF NOT EXISTS asset_type TEXT NOT NULL DEFAULT 'clean_final';

UPDATE support_deliveries
SET asset_type = 'clean_final'
WHERE asset_type IS NULL OR asset_type = '';

CREATE TABLE IF NOT EXISTS support_preview_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    source_file_id UUID NOT NULL REFERENCES support_files(id) ON DELETE CASCADE,
    file_id UUID REFERENCES support_files(id) ON DELETE SET NULL,
    asset_type TEXT NOT NULL,
    generation_status TEXT NOT NULL DEFAULT 'pending',
    access_tier TEXT NOT NULL,
    conversion_provider TEXT NOT NULL DEFAULT 'pdf_lib',
    conversion_job_id TEXT,
    page_count INTEGER,
    source_page_count INTEGER,
    watermark_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_clients_risk_tier_override_check'
          AND conrelid = 'support_clients'::regclass
    ) THEN
        ALTER TABLE support_clients
            ADD CONSTRAINT support_clients_risk_tier_override_check
            CHECK (risk_tier_override IS NULL OR risk_tier_override IN ('first_time', 'trusted', 'high_risk'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_requests_risk_tier_check'
          AND conrelid = 'support_requests'::regclass
    ) THEN
        ALTER TABLE support_requests
            ADD CONSTRAINT support_requests_risk_tier_check
            CHECK (risk_tier IN ('first_time', 'trusted', 'high_risk'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_requests_preview_status_check'
          AND conrelid = 'support_requests'::regclass
    ) THEN
        ALTER TABLE support_requests
            ADD CONSTRAINT support_requests_preview_status_check
            CHECK (preview_status IN ('not_started', 'pending', 'processing', 'ready', 'failed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_requests_preview_access_check'
          AND conrelid = 'support_requests'::regclass
    ) THEN
        ALTER TABLE support_requests
            ADD CONSTRAINT support_requests_preview_access_check
            CHECK (preview_access IN ('none', 'limited', 'full_protected', 'clean_final'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_deliveries_asset_type_check'
          AND conrelid = 'support_deliveries'::regclass
    ) THEN
        ALTER TABLE support_deliveries
            ADD CONSTRAINT support_deliveries_asset_type_check
            CHECK (asset_type = 'clean_final');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_preview_assets_type_check'
          AND conrelid = 'support_preview_assets'::regclass
    ) THEN
        ALTER TABLE support_preview_assets
            ADD CONSTRAINT support_preview_assets_type_check
            CHECK (asset_type IN ('limited_preview', 'full_protected_preview'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_preview_assets_status_check'
          AND conrelid = 'support_preview_assets'::regclass
    ) THEN
        ALTER TABLE support_preview_assets
            ADD CONSTRAINT support_preview_assets_status_check
            CHECK (generation_status IN ('pending', 'processing', 'ready', 'failed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'support_preview_assets_access_check'
          AND conrelid = 'support_preview_assets'::regclass
    ) THEN
        ALTER TABLE support_preview_assets
            ADD CONSTRAINT support_preview_assets_access_check
            CHECK (access_tier IN ('free', 'payment_required'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_preview_assets_request_type
    ON support_preview_assets(request_id, asset_type);

CREATE INDEX IF NOT EXISTS idx_support_preview_assets_request_status
    ON support_preview_assets(request_id, generation_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_requests_risk_preview
    ON support_requests(risk_tier, preview_status, updated_at DESC);

DROP TRIGGER IF EXISTS trg_support_preview_assets_updated_at ON support_preview_assets;
CREATE TRIGGER trg_support_preview_assets_updated_at
BEFORE UPDATE ON support_preview_assets
FOR EACH ROW
EXECUTE FUNCTION trigger_set_updated_at();
