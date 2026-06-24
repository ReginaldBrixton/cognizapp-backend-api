-- 069_support_image_preview_pages.sql
-- Provider-supplied page images replace runtime PDF preview generation for support deliveries.

CREATE TABLE IF NOT EXISTS support_preview_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES support_files(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    generation_status TEXT NOT NULL DEFAULT 'ready',
    access_tier TEXT NOT NULL DEFAULT 'free',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT support_preview_pages_page_number_check CHECK (page_number > 0),
    CONSTRAINT support_preview_pages_status_check CHECK (generation_status IN ('pending', 'processing', 'ready', 'failed')),
    CONSTRAINT support_preview_pages_access_check CHECK (access_tier IN ('free'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_preview_pages_request_page
    ON support_preview_pages(request_id, page_number);

CREATE INDEX IF NOT EXISTS idx_support_preview_pages_request_status
    ON support_preview_pages(request_id, generation_status, page_number);

DROP TRIGGER IF EXISTS trg_support_preview_pages_updated_at ON support_preview_pages;
CREATE TRIGGER trg_support_preview_pages_updated_at
BEFORE UPDATE ON support_preview_pages
FOR EACH ROW
EXECUTE FUNCTION trigger_set_updated_at();
