import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { resolveAuth } from "../auth/middleware";
import { aiChatService } from "./service";
import { isValidUuid } from "../../lib/validation";

const CreateConversationBody = t.Object({
  query: t.Optional(t.String({ maxLength: 500 })),
  title: t.Optional(t.String({ maxLength: 500 })),
  aiModel: t.Optional(t.String()),
  model: t.Optional(t.String()),
  thinkingLevel: t.Optional(
    t.Union([t.Literal("minimal"), t.Literal("low"), t.Literal("medium"), t.Literal("high")]),
  ),
});

const UpdateConversationBody = t.Partial(
  t.Object({
    title: t.String({ maxLength: 500 }),
    query: t.String({ maxLength: 500 }),
    model: t.String(),
    thinkingLevel: t.String(),
    isArchived: t.Boolean(),
    is_archived: t.Boolean(),
    isPinned: t.Boolean(),
    is_pinned: t.Boolean(),
    summary: t.String(),
  }),
);

const CreateMessageBody = t.Object({
  role: t.Union([t.Literal("user"), t.Literal("assistant"), t.Literal("system"), t.Literal("tool")]),
  content: t.String(),
  content_parts: t.Optional(t.Any()),
  contentParts: t.Optional(t.Any()),
  tool_calls: t.Optional(t.Any()),
  toolCalls: t.Optional(t.Any()),
  tool_call_id: t.Optional(t.String()),
  toolCallId: t.Optional(t.String()),
  model: t.Optional(t.String()),
  tokens_used: t.Optional(t.Number()),
  tokensUsed: t.Optional(t.Number()),
});

const BatchMessageBody = t.Object({
  messages: t.Array(CreateMessageBody),
});

const GenerateTitleBody = t.Object({
  first_message: t.String({ maxLength: 1000 }),
});

export const aiBotRoutes = new Elysia({
  prefix: "/api/workspaces/:workspaceId/chat",
  tags: ["ai-bot"],
})
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { success: false, error: error.message, errorCode: error.code };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { success: false, error: "Invalid request body", errorCode: "invalid_request" };
    }
  })
  // ── List conversations ─────────────────────────────────────────────
  .get("/", async ({ headers, params, query }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const filter = {
      search: (query as Record<string, string>).q || undefined,
      isArchived: (query as Record<string, string>).archived === "true",
      limit: Number((query as Record<string, string>).limit) || 50,
      page: Number((query as Record<string, string>).page) || 1,
    };
    const result = await aiChatService.listConversations(auth.userId, params.workspaceId, filter);
    return { items: result.items, total: result.total };
  })
  // ── Create conversation ────────────────────────────────────────────
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const title = body.query || body.title || "New Chat";
    const model = body.aiModel || body.model || "gemini-3.1-flash-lite";
    const conv = await aiChatService.createConversation(auth.userId, params.workspaceId, {
      title,
      model,
      thinkingLevel: body.thinkingLevel ?? "minimal",
    });
    return { item: conv };
  }, { body: CreateConversationBody })
  // ── Get conversation ───────────────────────────────────────────────
  .get("/:conversationId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const conv = await aiChatService.getConversation(params.conversationId, auth.userId);
    return { item: conv };
  })
  // ── Update conversation ────────────────────────────────────────────
  .patch("/:conversationId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const input: Record<string, unknown> = {};
    if (body.title ?? body.query) input.title = body.title ?? body.query;
    if (body.model) input.model = body.model;
    if (body.thinkingLevel) input.thinkingLevel = body.thinkingLevel;
    if (body.isArchived !== undefined || body.is_archived !== undefined) {
      input.isArchived = body.isArchived ?? body.is_archived;
    }
    if (body.isPinned !== undefined || body.is_pinned !== undefined) {
      input.isPinned = body.isPinned ?? body.is_pinned;
    }
    if (body.summary) input.summary = body.summary;

    const conv = await aiChatService.updateConversation(params.conversationId, auth.userId, input as any);
    return { item: conv };
  }, { body: UpdateConversationBody })
  // ── Delete conversation ────────────────────────────────────────────
  .delete("/:conversationId", async ({ headers, params, set }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    await aiChatService.deleteConversation(params.conversationId, auth.userId);
    set.status = 204;
    return "";
  })
  // ── Archive conversation ───────────────────────────────────────────
  .post("/:conversationId/archive", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const conv = await aiChatService.archiveConversation(params.conversationId, auth.userId);
    return { item: conv };
  })
  // ── Restore conversation ───────────────────────────────────────────
  .post("/:conversationId/restore", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const conv = await aiChatService.restoreConversation(params.conversationId, auth.userId);
    return { item: conv };
  })
  // ── List messages ──────────────────────────────────────────────────
  .get("/:conversationId/messages", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const messages = await aiChatService.listMessages(params.conversationId, auth.userId);
    return { conversation_id: params.conversationId, messages, total: messages.length };
  })
  // ── Create single message ─────────────────────────────────────────
  .post("/:conversationId/messages", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const msg = await aiChatService.createMessage(params.conversationId, auth.userId, {
      role: body.role,
      content: body.content,
      contentParts: body.contentParts ?? body.content_parts,
      toolCalls: body.toolCalls ?? body.tool_calls,
      toolCallId: body.toolCallId ?? body.tool_call_id,
      model: body.model,
      tokensUsed: body.tokensUsed ?? body.tokens_used,
    });
    return { item: msg };
  }, { body: CreateMessageBody })
  // ── Batch save messages ────────────────────────────────────────────
  .post("/:conversationId/messages/batch", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const inputs = body.messages.map((m) => ({
      role: m.role,
      content: m.content,
      contentParts: m.contentParts ?? m.content_parts,
      toolCalls: m.toolCalls ?? m.tool_calls,
      toolCallId: m.toolCallId ?? m.tool_call_id,
      model: m.model,
      tokensUsed: m.tokensUsed ?? m.tokens_used,
    }));
    const items = await aiChatService.createMessagesBatch(params.conversationId, auth.userId, inputs);
    return { saved: items.length, items };
  }, { body: BatchMessageBody })
  // ── Delete single message ──────────────────────────────────────────
  .delete("/:conversationId/messages/:messageId", async ({ headers, params, set }) => {
    if (
      !isValidUuid(params.workspaceId) ||
      !isValidUuid(params.conversationId) ||
      !isValidUuid(params.messageId)
    ) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    await aiChatService.deleteMessage(params.messageId, params.conversationId, auth.userId);
    set.status = 204;
    return "";
  })
  // ── Clear all messages ─────────────────────────────────────────────
  .delete("/:conversationId/messages", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const count = await aiChatService.clearMessages(params.conversationId, auth.userId);
    return { cleared: count };
  })
  // ── Generate title ─────────────────────────────────────────────────
  .post("/:conversationId/generate-title", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const title = await aiChatService.generateTitle(
      params.conversationId,
      auth.userId,
      body.first_message,
    );
    return { title, generated: true };
  }, { body: GenerateTitleBody })
  // ── Get context window (for debugging/advanced use) ────────────────
  .get("/:conversationId/context", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.conversationId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const ctx = await aiChatService.buildContextWindow(params.conversationId, auth.userId);
    return ctx;
  });
