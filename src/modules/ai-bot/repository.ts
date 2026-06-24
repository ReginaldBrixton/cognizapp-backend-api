import type { JSONValue } from "postgres";
import { getDb } from "../../lib/db";
import type {
  AiConversation,
  AiMessage,
  AiSummary,
  CreateConversationInput,
  UpdateConversationInput,
  CreateMessageInput,
  ConversationFilter,
} from "./types";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

function mapConversation(row: Record<string, unknown>): AiConversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title ?? "New Chat"),
    model: String(row.model ?? "gemini-3.1-flash-lite"),
    thinkingLevel: String(row.thinking_level ?? "minimal"),
    messageCount: Number(row.message_count ?? 0),
    userPromptCount: Number(row.user_prompt_count ?? 0),
    isArchived: Boolean(row.is_archived),
    isPinned: Boolean(row.is_pinned),
    summary: row.summary ? String(row.summary) : null,
    lastSummaryAt: row.last_summary_at ? String(row.last_summary_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessage(row: Record<string, unknown>): AiMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role) as AiMessage["role"],
    content: String(row.content ?? ""),
    contentParts: (row.content_parts as unknown[] | null) ?? null,
    toolCalls: (row.tool_calls as unknown[] | null) ?? null,
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null,
    model: row.model ? String(row.model) : null,
    tokensUsed: row.tokens_used ? Number(row.tokens_used) : null,
    createdAt: String(row.created_at),
  };
}

function mapSummary(row: Record<string, unknown>): AiSummary {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    summary: String(row.summary),
    messagesCovered: Number(row.messages_covered),
    promptCountAt: Number(row.prompt_count_at),
    createdAt: String(row.created_at),
  };
}

export const aiChatRepository = {
  // ── Conversations ──────────────────────────────────────────────────

  async listConversations(
    userId: string,
    workspaceId: string,
    filter?: ConversationFilter,
  ): Promise<{ items: AiConversation[]; total: number }> {
    const db = getDb();
    const isArchived = filter?.isArchived ?? false;
    const limit = filter?.limit ?? 50;
    const offset = ((filter?.page ?? 1) - 1) * limit;

    let whereExtra = "";
    const params: (string | number | boolean)[] = [userId, workspaceId, isArchived];

    if (filter?.search) {
      params.push(`%${filter.search}%`);
      whereExtra = ` AND title ILIKE $${params.length}`;
    }

    const countRows = await db.unsafe(
      `SELECT count(*)::int AS total FROM app.ai_conversations
       WHERE user_id = $1 AND workspace_id = $2 AND is_archived = $3${whereExtra}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);

    params.push(limit, offset);
    const rows = await db.unsafe(
      `SELECT * FROM app.ai_conversations
       WHERE user_id = $1 AND workspace_id = $2 AND is_archived = $3${whereExtra}
       ORDER BY is_pinned DESC, updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { items: rows.map(mapConversation), total };
  },

  async getConversation(id: string, userId: string): Promise<AiConversation | null> {
    const db = getDb();
    const rows = await db.unsafe(
      `SELECT * FROM app.ai_conversations WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? mapConversation(rows[0]) : null;
  },

  async createConversation(
    userId: string,
    workspaceId: string,
    input: CreateConversationInput,
  ): Promise<AiConversation> {
    const db = getDb();
    const rows = await db.unsafe(
      `INSERT INTO app.ai_conversations (user_id, workspace_id, title, model, thinking_level)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        userId,
        workspaceId,
        input.title,
        input.model ?? "gemini-3.1-flash-lite",
        input.thinkingLevel ?? "minimal",
      ],
    );
    return mapConversation(rows[0]);
  },

  async updateConversation(
    id: string,
    userId: string,
    input: UpdateConversationInput,
  ): Promise<AiConversation | null> {
    const db = getDb();
    const sets: string[] = ["updated_at = now()"];
    const params: (string | number | boolean)[] = [id, userId];

    if (input.title !== undefined) {
      params.push(input.title);
      sets.push(`title = $${params.length}`);
    }
    if (input.model !== undefined) {
      params.push(input.model);
      sets.push(`model = $${params.length}`);
    }
    if (input.thinkingLevel !== undefined) {
      params.push(input.thinkingLevel);
      sets.push(`thinking_level = $${params.length}`);
    }
    if (input.isArchived !== undefined) {
      params.push(input.isArchived);
      sets.push(`is_archived = $${params.length}`);
    }
    if (input.isPinned !== undefined) {
      params.push(input.isPinned);
      sets.push(`is_pinned = $${params.length}`);
    }
    if (input.summary !== undefined) {
      params.push(input.summary);
      sets.push(`summary = $${params.length}`);
      sets.push("last_summary_at = now()");
    }

    const rows = await db.unsafe(
      `UPDATE app.ai_conversations SET ${sets.join(", ")}
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      params,
    );
    return rows[0] ? mapConversation(rows[0]) : null;
  },

  async deleteConversation(id: string, userId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db.unsafe(
      `DELETE FROM app.ai_conversations WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    return rows.length > 0;
  },

  // ── Messages ───────────────────────────────────────────────────────

  async listMessages(conversationId: string): Promise<AiMessage[]> {
    const db = getDb();
    const rows = await db.unsafe(
      `SELECT * FROM app.ai_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
    return rows.map(mapMessage);
  },

  async createMessage(conversationId: string, input: CreateMessageInput): Promise<AiMessage> {
    const db = getDb();
    const rows = await db.unsafe(
      `INSERT INTO app.ai_messages (conversation_id, role, content, content_parts, tool_calls, tool_call_id, model, tokens_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        conversationId,
        input.role,
        input.content,
        input.contentParts ? toJsonValue(input.contentParts) : null,
        input.toolCalls ? toJsonValue(input.toolCalls) : null,
        input.toolCallId ?? null,
        input.model ?? null,
        input.tokensUsed ?? null,
      ],
    );

    // Update conversation counters
    const counterUpdate =
      input.role === "user"
        ? "message_count = message_count + 1, user_prompt_count = user_prompt_count + 1, updated_at = now()"
        : "message_count = message_count + 1, updated_at = now()";
    await db.unsafe(
      `UPDATE app.ai_conversations SET ${counterUpdate} WHERE id = $1`,
      [conversationId],
    );

    return mapMessage(rows[0]);
  },

  async createMessagesBatch(
    conversationId: string,
    messages: CreateMessageInput[],
  ): Promise<AiMessage[]> {
    const db = getDb();
    const results: AiMessage[] = [];
    let userCount = 0;

    for (const input of messages) {
      const rows = await db.unsafe(
        `INSERT INTO app.ai_messages (conversation_id, role, content, content_parts, tool_calls, tool_call_id, model, tokens_used)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          conversationId,
          input.role,
          input.content,
          input.contentParts ? toJsonValue(input.contentParts) : null,
          input.toolCalls ? toJsonValue(input.toolCalls) : null,
          input.toolCallId ?? null,
          input.model ?? null,
          input.tokensUsed ?? null,
        ],
      );
      results.push(mapMessage(rows[0]));
      if (input.role === "user") userCount++;
    }

    // Batch update counters
    await db.unsafe(
      `UPDATE app.ai_conversations
       SET message_count = message_count + $2,
           user_prompt_count = user_prompt_count + $3,
           updated_at = now()
       WHERE id = $1`,
      [conversationId, messages.length, userCount],
    );

    return results;
  },

  async deleteMessage(messageId: string, conversationId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db.unsafe(
      `DELETE FROM app.ai_messages WHERE id = $1 AND conversation_id = $2 RETURNING id`,
      [messageId, conversationId],
    );
    if (rows.length > 0) {
      await db.unsafe(
        `UPDATE app.ai_conversations SET message_count = GREATEST(message_count - 1, 0), updated_at = now() WHERE id = $1`,
        [conversationId],
      );
    }
    return rows.length > 0;
  },

  async deleteAllMessages(conversationId: string): Promise<number> {
    const db = getDb();
    const rows = await db.unsafe(
      `DELETE FROM app.ai_messages WHERE conversation_id = $1 RETURNING id`,
      [conversationId],
    );
    if (rows.length > 0) {
      await db.unsafe(
        `UPDATE app.ai_conversations SET message_count = 0, user_prompt_count = 0, updated_at = now() WHERE id = $1`,
        [conversationId],
      );
    }
    return rows.length;
  },

  // ── Summaries ──────────────────────────────────────────────────────

  async getLatestSummary(conversationId: string): Promise<AiSummary | null> {
    const db = getDb();
    const rows = await db.unsafe(
      `SELECT * FROM app.ai_summaries WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    return rows[0] ? mapSummary(rows[0]) : null;
  },

  async createSummary(
    conversationId: string,
    summary: string,
    messagesCovered: number,
    promptCountAt: number,
  ): Promise<AiSummary> {
    const db = getDb();
    const rows = await db.unsafe(
      `INSERT INTO app.ai_summaries (conversation_id, summary, messages_covered, prompt_count_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [conversationId, summary, messagesCovered, promptCountAt],
    );

    // Also update conversation's summary field
    await db.unsafe(
      `UPDATE app.ai_conversations SET summary = $2, last_summary_at = now(), updated_at = now() WHERE id = $1`,
      [conversationId, summary],
    );

    return mapSummary(rows[0]);
  },

  async getConversationUserPromptCount(conversationId: string): Promise<number> {
    const db = getDb();
    const rows = await db.unsafe(
      `SELECT user_prompt_count FROM app.ai_conversations WHERE id = $1`,
      [conversationId],
    );
    return Number(rows[0]?.user_prompt_count ?? 0);
  },

  async getMessagesSinceSummary(conversationId: string, summaryCreatedAt: string): Promise<AiMessage[]> {
    const db = getDb();
    const rows = await db.unsafe(
      `SELECT * FROM app.ai_messages
       WHERE conversation_id = $1 AND created_at > $2
       ORDER BY created_at ASC`,
      [conversationId, summaryCreatedAt],
    );
    return rows.map(mapMessage);
  },
};
