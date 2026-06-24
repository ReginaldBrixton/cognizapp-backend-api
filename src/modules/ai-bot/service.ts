import { HttpError } from "../../lib/errors";
import { aiChatRepository } from "./repository";
import type {
  AiConversation,
  AiMessage,
  CreateConversationInput,
  UpdateConversationInput,
  CreateMessageInput,
  ConversationFilter,
} from "./types";

const SUMMARY_TRIGGER_INTERVAL = 10;

export const aiChatService = {
  // ── Conversations ──────────────────────────────────────────────────

  async listConversations(
    userId: string,
    workspaceId: string,
    filter?: ConversationFilter,
  ): Promise<{ items: AiConversation[]; total: number }> {
    return aiChatRepository.listConversations(userId, workspaceId, filter);
  },

  async getConversation(id: string, userId: string): Promise<AiConversation> {
    const conv = await aiChatRepository.getConversation(id, userId);
    if (!conv) {
      throw new HttpError(404, "not_found", "Conversation not found");
    }
    return conv;
  },

  async createConversation(
    userId: string,
    workspaceId: string,
    input: CreateConversationInput,
  ): Promise<AiConversation> {
    return aiChatRepository.createConversation(userId, workspaceId, input);
  },

  async updateConversation(
    id: string,
    userId: string,
    input: UpdateConversationInput,
  ): Promise<AiConversation> {
    const updated = await aiChatRepository.updateConversation(id, userId, input);
    if (!updated) {
      throw new HttpError(404, "not_found", "Conversation not found");
    }
    return updated;
  },

  async deleteConversation(id: string, userId: string): Promise<void> {
    const deleted = await aiChatRepository.deleteConversation(id, userId);
    if (!deleted) {
      throw new HttpError(404, "not_found", "Conversation not found");
    }
  },

  async archiveConversation(id: string, userId: string): Promise<AiConversation> {
    return this.updateConversation(id, userId, { isArchived: true });
  },

  async restoreConversation(id: string, userId: string): Promise<AiConversation> {
    return this.updateConversation(id, userId, { isArchived: false });
  },

  // ── Messages ───────────────────────────────────────────────────────

  async listMessages(conversationId: string, userId: string): Promise<AiMessage[]> {
    // Verify ownership
    await this.getConversation(conversationId, userId);
    return aiChatRepository.listMessages(conversationId);
  },

  async createMessage(
    conversationId: string,
    userId: string,
    input: CreateMessageInput,
  ): Promise<AiMessage> {
    // Verify ownership
    await this.getConversation(conversationId, userId);
    const msg = await aiChatRepository.createMessage(conversationId, input);

    // Check if we should trigger a summary
    if (input.role === "user") {
      this.checkAndTriggerSummary(conversationId).catch((err) =>
        console.error("[ai-bot] Summary generation failed:", err),
      );
    }

    return msg;
  },

  async createMessagesBatch(
    conversationId: string,
    userId: string,
    messages: CreateMessageInput[],
  ): Promise<AiMessage[]> {
    // Verify ownership
    await this.getConversation(conversationId, userId);
    const results = await aiChatRepository.createMessagesBatch(conversationId, messages);

    // Check if any user messages were included
    const hasUserMessage = messages.some((m) => m.role === "user");
    if (hasUserMessage) {
      this.checkAndTriggerSummary(conversationId).catch((err) =>
        console.error("[ai-bot] Summary generation failed:", err),
      );
    }

    return results;
  },

  async deleteMessage(messageId: string, conversationId: string, userId: string): Promise<void> {
    await this.getConversation(conversationId, userId);
    const deleted = await aiChatRepository.deleteMessage(messageId, conversationId);
    if (!deleted) {
      throw new HttpError(404, "not_found", "Message not found");
    }
  },

  async clearMessages(conversationId: string, userId: string): Promise<number> {
    await this.getConversation(conversationId, userId);
    return aiChatRepository.deleteAllMessages(conversationId);
  },

  // ── Title Generation ───────────────────────────────────────────────

  async generateTitle(
    conversationId: string,
    userId: string,
    firstMessage: string,
  ): Promise<string> {
    await this.getConversation(conversationId, userId);

    const title = firstMessage.length > 60 ? firstMessage.slice(0, 57) + "..." : firstMessage;

    await aiChatRepository.updateConversation(conversationId, userId, { title });
    return title;
  },

  // ── Context Summarization ─────────────────────────────────────────

  async checkAndTriggerSummary(conversationId: string): Promise<void> {
    const promptCount = await aiChatRepository.getConversationUserPromptCount(conversationId);
    const latestSummary = await aiChatRepository.getLatestSummary(conversationId);
    const lastSummarizedAt = latestSummary?.promptCountAt ?? 0;

    // Trigger every SUMMARY_TRIGGER_INTERVAL user prompts
    if (promptCount - lastSummarizedAt >= SUMMARY_TRIGGER_INTERVAL) {
      console.log(
        `[ai-bot] Triggering summary for conversation ${conversationId} at prompt count ${promptCount}`,
      );

      let messages: AiMessage[];
      if (latestSummary) {
        messages = await aiChatRepository.getMessagesSinceSummary(
          conversationId,
          latestSummary.createdAt,
        );
      } else {
        messages = await aiChatRepository.listMessages(conversationId);
      }

      if (messages.length === 0) return;

      const summaryText = this.buildSummaryFromMessages(messages, latestSummary?.summary);

      await aiChatRepository.createSummary(
        conversationId,
        summaryText,
        messages.length,
        promptCount,
      );

      console.log(
        `[ai-bot] Summary saved for conversation ${conversationId}: ${summaryText.length} chars`,
      );
    }
  },

  buildSummaryFromMessages(
    messages: AiMessage[],
    previousSummary?: string | null,
  ): string {
    const parts: string[] = [];

    if (previousSummary) {
      parts.push(`Previous context: ${previousSummary}`);
    }

    // Extract key points from the conversation segment
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    parts.push(`Topics discussed (${userMessages.length} user messages):`);
    for (const msg of userMessages) {
      const preview = msg.content.length > 150 ? msg.content.slice(0, 147) + "..." : msg.content;
      parts.push(`- User asked: ${preview}`);
    }

    if (assistantMessages.length > 0) {
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      if (lastAssistant) {
        const preview =
          lastAssistant.content.length > 200
            ? lastAssistant.content.slice(0, 197) + "..."
            : lastAssistant.content;
        parts.push(`Last assistant response summary: ${preview}`);
      }
    }

    return parts.join("\n");
  },

  // ── Context Building (for AI API calls) ────────────────────────────

  async buildContextWindow(
    conversationId: string,
    userId: string,
  ): Promise<{ summary: string | null; messages: AiMessage[] }> {
    await this.getConversation(conversationId, userId);

    const latestSummary = await aiChatRepository.getLatestSummary(conversationId);

    let messages: AiMessage[];
    if (latestSummary) {
      messages = await aiChatRepository.getMessagesSinceSummary(
        conversationId,
        latestSummary.createdAt,
      );
    } else {
      messages = await aiChatRepository.listMessages(conversationId);
    }

    return {
      summary: latestSummary?.summary ?? null,
      messages,
    };
  },
};
