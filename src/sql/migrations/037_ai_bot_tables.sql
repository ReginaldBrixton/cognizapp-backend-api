-- AI Bot: conversations, messages, and summaries
-- Schema: app (workspace/product data)

CREATE TABLE IF NOT EXISTS app.ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT 'New Chat',
  model TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
  thinking_level TEXT NOT NULL DEFAULT 'minimal',
  message_count INT NOT NULL DEFAULT 0,
  user_prompt_count INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  summary TEXT,
  last_summary_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user
  ON app.ai_conversations(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_workspace
  ON app.ai_conversations(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_archived
  ON app.ai_conversations(user_id, is_archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS app.ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES app.ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  content_parts JSONB,
  tool_calls JSONB,
  tool_call_id TEXT,
  model TEXT,
  tokens_used INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
  ON app.ai_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS app.ai_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES app.ai_conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  messages_covered INT NOT NULL,
  prompt_count_at INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_summaries_conversation
  ON app.ai_summaries(conversation_id, created_at DESC);
