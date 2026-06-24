CREATE TABLE IF NOT EXISTS support_request_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_request_versions_request_version
  ON support_request_versions(request_id, version_number);

CREATE INDEX IF NOT EXISTS idx_support_request_versions_request_changed
  ON support_request_versions(request_id, changed_at DESC);
