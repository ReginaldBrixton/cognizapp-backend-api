export interface AiConversation {
  id: string;
  userId: string;
  workspaceId: string;
  title: string;
  model: string;
  thinkingLevel: string;
  messageCount: number;
  userPromptCount: number;
  isArchived: boolean;
  isPinned: boolean;
  summary: string | null;
  lastSummaryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  contentParts: unknown[] | null;
  toolCalls: unknown[] | null;
  toolCallId: string | null;
  model: string | null;
  tokensUsed: number | null;
  createdAt: string;
}

export interface AiSummary {
  id: string;
  conversationId: string;
  summary: string;
  messagesCovered: number;
  promptCountAt: number;
  createdAt: string;
}

export interface CreateConversationInput {
  title: string;
  model?: string;
  thinkingLevel?: string;
}

export interface UpdateConversationInput {
  title?: string;
  model?: string;
  thinkingLevel?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  summary?: string;
}

export interface CreateMessageInput {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  contentParts?: unknown[];
  toolCalls?: unknown[];
  toolCallId?: string;
  model?: string;
  tokensUsed?: number;
}

export interface ConversationFilter {
  search?: string;
  isArchived?: boolean;
  limit?: number;
  page?: number;
}
