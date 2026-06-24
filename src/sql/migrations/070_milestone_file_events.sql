SET search_path TO app, auth, public;

CREATE TABLE IF NOT EXISTS milestone_file_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  milestone_id UUID REFERENCES request_milestones(id) ON DELETE SET NULL,
  file_id UUID REFERENCES support_files(id) ON DELETE SET NULL,
  actor_key_id TEXT NOT NULL,
  actor_role TEXT NOT NULL DEFAULT 'provider',
  event_type TEXT NOT NULL,
  file_name TEXT,
  previous_file_name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE milestone_file_events
  DROP CONSTRAINT IF EXISTS milestone_file_events_type_check;

ALTER TABLE milestone_file_events
  ADD CONSTRAINT milestone_file_events_type_check
  CHECK (event_type IN (
    'uploaded',
    'card_sent',
    'card_updated',
    'replaced',
    'deleted',
    'accepted',
    'revision_requested',
    'locked',
    'unlocked'
  ));

CREATE INDEX IF NOT EXISTS idx_milestone_file_events_request_created
  ON milestone_file_events(request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_milestone_file_events_milestone_created
  ON milestone_file_events(milestone_id, created_at DESC)
  WHERE milestone_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_request_milestones_request_updated
  ON request_milestones(request_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_messages_milestone_cards
  ON support_messages USING GIN (attachments jsonb_path_ops);
