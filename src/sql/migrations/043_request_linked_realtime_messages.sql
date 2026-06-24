-- Request-linked support messaging hardening and realtime hot-path indexes.
-- Target: cognizap database, app schema.

CREATE UNIQUE INDEX IF NOT EXISTS ux_support_message_threads_request_user
  ON support_message_threads(request_id, user_key_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_messages_thread_created_id
  ON support_messages(thread_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_support_messages_thread_unread
  ON support_messages(thread_id, sender_key_id, created_at DESC)
  WHERE read_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_files_request_created
  ON support_files(request_id, created_at DESC, id DESC)
  WHERE request_id IS NOT NULL;
