ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS ai_reasoning TEXT,
  ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS file_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS structured_output JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_support_messages_prompt_hash
  ON support_messages(prompt_hash)
  WHERE prompt_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_messages_mentions_gin
  ON support_messages USING GIN (mentions);

CREATE INDEX IF NOT EXISTS idx_support_messages_file_references_gin
  ON support_messages USING GIN (file_references);

CREATE TABLE IF NOT EXISTS support_ai_response_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key_id TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '',
  complexity TEXT NOT NULL DEFAULT 'simple',
  action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  structured_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_key_id, prompt_hash)
);

CREATE INDEX IF NOT EXISTS idx_support_ai_response_cache_user_created
  ON support_ai_response_cache(user_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_threads_user_type
  ON support_message_threads(user_key_id, type, updated_at DESC);
