-- Add edit, delete, and reply functionality to support messages
-- Migration: 030_message_interactions

-- Add columns for message editing, deletion, and replies
ALTER TABLE support_messages
ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES support_messages(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS deleted_by TEXT,
ADD COLUMN IF NOT EXISTS edit_history JSONB DEFAULT '[]'::jsonb;

-- Create index for reply lookups
CREATE INDEX IF NOT EXISTS idx_support_messages_reply_to ON support_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

-- Create index for soft-deleted messages
CREATE INDEX IF NOT EXISTS idx_support_messages_deleted ON support_messages(thread_id, deleted_at) WHERE deleted_at IS NULL;

-- Add comment explaining the columns
COMMENT ON COLUMN support_messages.reply_to_message_id IS 'Reference to the message being replied to';
COMMENT ON COLUMN support_messages.edited_at IS 'Timestamp when message was last edited';
COMMENT ON COLUMN support_messages.deleted_at IS 'Soft delete timestamp';
COMMENT ON COLUMN support_messages.deleted_by IS 'User key ID who deleted the message';
COMMENT ON COLUMN support_messages.edit_history IS 'Array of edit records: [{content: string, editedAt: timestamp, editedBy: string}]';
