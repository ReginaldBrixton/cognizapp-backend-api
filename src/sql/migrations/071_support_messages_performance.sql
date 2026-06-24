-- Performance optimization indexes for support messages
-- Migration: 071_support_messages_performance

-- Composite index for thread message queries (common: thread_id + created_at + deleted filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_messages_thread_created_active
  ON support_messages(thread_id, created_at ASC)
  WHERE deleted_at IS NULL;

-- Composite index for unread message counting (sender exclusion + read_by check)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_messages_unread_lookup
  ON support_messages(thread_id, sender_key_id)
  WHERE deleted_at IS NULL;

-- Index for sender's editable messages lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_messages_sender_editable
  ON support_messages(sender_key_id, thread_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Composite index for thread last message queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_message_threads_updated
  ON support_message_threads(user_key_id, last_message_at DESC, updated_at DESC)
  WHERE request_id IS NOT NULL;

-- Provider view: all threads with recent activity
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_message_threads_provider_active
  ON support_message_threads(last_message_at DESC, updated_at DESC)
  WHERE request_id IS NOT NULL;

-- Index for request_id lookups (common join column)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_message_threads_request
  ON support_message_threads(request_id)
  WHERE request_id IS NOT NULL;

-- Optimize support request queries by status + payment
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_requests_status_payment_updated
  ON support_requests(status, payment_status, updated_at DESC);

-- User's request listing with status filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_requests_user_status_created
  ON support_requests(user_key_id, status, created_at DESC);
