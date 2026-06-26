SET search_path TO app, auth, public;

-- Add submission_round tracking to milestones.
-- Each time a provider resubmits after a revision, the round increments.
-- Round 1 = initial submission, Round 2 = first revision resubmission, etc.
ALTER TABLE request_milestones
  ADD COLUMN IF NOT EXISTS submission_round INTEGER NOT NULL DEFAULT 0;

-- Add submission_round to support_files so we know which round each file belongs to.
ALTER TABLE support_files
  ADD COLUMN IF NOT EXISTS submission_round INTEGER NOT NULL DEFAULT 1;

-- Add submission_round to support_revisions to track which round triggered the revision.
ALTER TABLE support_revisions
  ADD COLUMN IF NOT EXISTS submission_round INTEGER NOT NULL DEFAULT 1;

-- Add submission_round to milestone_file_events for history grouping.
ALTER TABLE milestone_file_events
  ADD COLUMN IF NOT EXISTS submission_round INTEGER NOT NULL DEFAULT 1;

-- Index for fetching milestones by request ordered by round
CREATE INDEX IF NOT EXISTS idx_request_milestones_request_round
  ON request_milestones(request_id, submission_round);

-- Index for fetching files by milestone and round
CREATE INDEX IF NOT EXISTS idx_support_files_milestone_round
  ON support_files(milestone_id, submission_round, created_at DESC)
  WHERE milestone_id IS NOT NULL;

-- Index for fetching revisions by milestone and round
CREATE INDEX IF NOT EXISTS idx_support_revisions_milestone_round
  ON support_revisions(milestone_id, submission_round, created_at DESC)
  WHERE milestone_id IS NOT NULL;

-- Index for fetching file events by milestone and round
CREATE INDEX IF NOT EXISTS idx_milestone_file_events_milestone_round
  ON milestone_file_events(milestone_id, submission_round, created_at DESC)
  WHERE milestone_id IS NOT NULL;
