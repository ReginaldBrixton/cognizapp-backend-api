-- Ensure support request conversations follow the request lifecycle.

ALTER TABLE support_message_threads
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'support_message_threads_status_check'
      AND conrelid = 'support_message_threads'::regclass
  ) THEN
    ALTER TABLE support_message_threads
      ADD CONSTRAINT support_message_threads_status_check
      CHECK (status IN ('active', 'completed', 'archived'));
  END IF;
END $$;

UPDATE support_message_threads t
SET status = 'completed',
  completed_at = COALESCE(t.completed_at, r.updated_at, NOW())
FROM support_requests r
WHERE t.request_id = r.id
  AND r.status IN ('completed', 'closed')
  AND t.status != 'completed';

DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT c.conname
  INTO fk_name
  FROM pg_constraint c
  JOIN pg_attribute a
    ON a.attrelid = c.conrelid
    AND a.attnum = ANY(c.conkey)
  WHERE c.conrelid = 'support_message_threads'::regclass
    AND c.confrelid = 'support_requests'::regclass
    AND c.contype = 'f'
    AND a.attname = 'request_id'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE support_message_threads DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE support_message_threads
    ADD CONSTRAINT support_message_threads_request_id_fkey
    FOREIGN KEY (request_id)
    REFERENCES support_requests(id)
    ON DELETE CASCADE;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_message_threads_status_updated
  ON support_message_threads(status, updated_at DESC);
