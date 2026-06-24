SET search_path TO app, auth, public;

CREATE TABLE IF NOT EXISTS request_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_notes TEXT NOT NULL DEFAULT '',
  user_feedback TEXT NOT NULL DEFAULT '',
  revision_count INTEGER NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  auto_approved_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'request_milestones_status_check'
      AND conrelid = 'request_milestones'::regclass
  ) THEN
    ALTER TABLE request_milestones
      ADD CONSTRAINT request_milestones_status_check
      CHECK (status IN (
        'pending',
        'active',
        'submitted',
        'revision_requested',
        'approved',
        'auto_approved',
        'disputed',
        'cancelled'
      ));
  END IF;
END $$;

ALTER TABLE support_revisions
  ADD COLUMN IF NOT EXISTS milestone_id UUID REFERENCES request_milestones(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'Other';

ALTER TABLE support_files
  ADD COLUMN IF NOT EXISTS milestone_id UUID REFERENCES request_milestones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_request_milestones_request_status
  ON request_milestones(request_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_request_milestones_due
  ON request_milestones(due_at)
  WHERE due_at IS NOT NULL AND status IN ('pending', 'active', 'submitted', 'revision_requested');

CREATE INDEX IF NOT EXISTS idx_support_revisions_milestone
  ON support_revisions(milestone_id, created_at);

CREATE INDEX IF NOT EXISTS idx_support_files_milestone
  ON support_files(milestone_id, created_at);

CREATE TABLE IF NOT EXISTS support_discount_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  user_key_id TEXT NOT NULL,
  provider_key_id TEXT NOT NULL,
  requested_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  approved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'support_discount_requests_status_check'
      AND conrelid = 'support_discount_requests'::regclass
  ) THEN
    ALTER TABLE support_discount_requests
      ADD CONSTRAINT support_discount_requests_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_discount_requests_request_status
  ON support_discount_requests(request_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_request_milestones_updated_at ON request_milestones;
CREATE TRIGGER trg_request_milestones_updated_at
BEFORE UPDATE ON request_milestones
FOR EACH ROW
EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_support_discount_requests_updated_at ON support_discount_requests;
CREATE TRIGGER trg_support_discount_requests_updated_at
BEFORE UPDATE ON support_discount_requests
FOR EACH ROW
EXECUTE FUNCTION trigger_set_updated_at();
