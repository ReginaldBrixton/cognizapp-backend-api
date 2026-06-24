import { Elysia, t } from "elysia";

import { cache } from "../../lib/cache";
import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import {
  generateSupportAiResponse,
  getPublicSupportAiModelName,
  hashSupportPrompt,
  getSupportAiModel,
} from "../../lib/gemini";
import { fail, ok } from "../../lib/http";
import { resolveAuth, type AuthContext } from "../auth/middleware";
import {
  addSupportEvent,
  canSeeProvider,
  invalidateProviderSupportCache,
  invalidateSupportCache,
  sendSupportEmail,
  toCamel,
} from "../support/shared";

const supportAdminEmailRecipients = ["reginaldbrixton@gmail.com", "cognizap@gmail.com"];
const maxSupportMessageLength = 12000;
const supportRealtimeStreamMs = 55000;

function mapSupportThread(row: Record<string, any>) {
  const thread = toCamel(row);
  const clientName = String(row.client_name ?? row.client_email ?? "Client");
  const clientEmail = String(row.client_email ?? "");
  return {
    ...thread,
    requestTitle: row.request_title ?? null,
    requestTaskId: row.task_id ?? null,
    requestStatus: row.request_status ?? null,
    participants: [
      {
        userId: String(row.user_key_id),
        name: clientName,
        role: "client",
        email: clientEmail,
      },
      {
        userId: "cognizap-support",
        name: "CognizApp Support",
        role: "admin",
      },
    ],
    lastMessage: row.last_message_id
      ? {
        id: row.last_message_id,
        threadId: row.id,
        senderKeyId: row.last_message_sender_key_id,
        senderName: row.last_message_sender_name,
        senderRole: row.last_message_sender_role,
        content: row.last_message_content,
        createdAt: row.last_message_created_at,
      }
      : null,
  };
}

function normalizeMessageBody(body: Record<string, any>) {
  const content = String(body.content ?? body.body ?? "").trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const fileReferences = Array.isArray(body.fileReferences)
    ? body.fileReferences
    : Array.isArray(body.file_references)
      ? body.file_references
      : [];
  const mentions = Array.isArray(body.mentions) ? body.mentions : [];

  if (!content && attachments.length === 0 && fileReferences.length === 0) {
    throw new HttpError(400, "message_required", "Message text or attachment is required");
  }
  if (content.length > maxSupportMessageLength) {
    throw new HttpError(413, "message_too_large", "Message is too large");
  }

  return { content, attachments, fileReferences, mentions };
}

function sanitizeMessageAttachments(attachments: unknown) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((attachment) => {
    if (!attachment || typeof attachment !== "object") return attachment;
    const item = { ...(attachment as Record<string, any>) };
    const fileId = String(item.fileId ?? item.id ?? "").trim();
    if (fileId && (!item.kind || item.kind === "file")) {
      item.url = `/api/support/files/${fileId}/download`;
      item.externalUrl = null;
      delete item.externalFileId;
      delete item.externalFileUrl;
    }
    if (Array.isArray(item.files)) {
      item.files = item.files.map((file: Record<string, any>) => {
        const nested = { ...file };
        const nestedId = String(nested.fileId ?? nested.id ?? "").trim();
        if (nestedId) nested.url = `/api/support/files/${nestedId}/download`;
        nested.externalUrl = null;
        delete nested.externalFileId;
        delete nested.externalFileUrl;
        return nested;
      });
    }
    return item;
  });
}

function mapSupportMessage(message: Record<string, any>, viewerUserId?: string) {
  const mapped = toCamel(message);
  mapped.attachments = sanitizeMessageAttachments(mapped.attachments);
  if (message.deleted_at) {
    mapped.content = "This message has been deleted";
    mapped.attachments = [];
    mapped.replyToMessage = null;
  }
  if (message.reply_to_message_id) {
    mapped.replyToMessage = {
      id: message.reply_to_message_id,
      content: message.reply_to_content ?? "Original message unavailable",
      senderName: message.reply_to_sender_name ?? "Participant",
      senderRole: message.reply_to_sender_role ?? "client",
      createdAt: message.reply_to_created_at ?? null,
    };
  }
  if (message.deleted_at) mapped.replyToMessage = null;
  if (viewerUserId) {
    const ownsMessage = String(message.sender_key_id ?? "") === viewerUserId;
    mapped.canEdit = ownsMessage && !message.deleted_at;
    mapped.canDelete = ownsMessage && !message.deleted_at;
  }
  return mapped;
}

async function getSupportMessageWithReply(messageId: string, viewerUserId?: string) {
  const [message] = await getDb()`
    SELECT m.*,
      reply_msg.content AS reply_to_content,
      reply_msg.sender_name AS reply_to_sender_name,
      reply_msg.sender_role AS reply_to_sender_role,
      reply_msg.created_at AS reply_to_created_at
    FROM support_messages m
    LEFT JOIN support_messages reply_msg ON reply_msg.id = m.reply_to_message_id
    WHERE m.id = ${messageId}::uuid
    LIMIT 1
  `;
  if (!message) return null;
  return mapSupportMessage(message, viewerUserId);
}

export async function getAuthorizedSupportMessageThread(
  auth: AuthContext,
  threadId: string,
) {
  const db = getDb();
  const provider = canSeeProvider(auth);
  const [thread] = provider
    ? await db`
      SELECT *
      FROM support_message_threads
      WHERE id = ${threadId}::uuid
        AND request_id IS NOT NULL
      LIMIT 1
    `
    : await db`
      SELECT *
      FROM support_message_threads
      WHERE id = ${threadId}::uuid
        AND request_id IS NOT NULL
        AND user_key_id = ${auth.userId}
      LIMIT 1
    `;
  if (!thread) throw new HttpError(404, "thread_not_found", "Message thread not found");
  return { thread, provider };
}

export async function createSupportMessage(
  auth: AuthContext,
  threadId: string,
  body: Record<string, any>,
) {
  const db = getDb();
  const { thread, provider } = await getAuthorizedSupportMessageThread(auth, threadId);
  if (String(thread.status ?? "active") === "completed") {
    throw new HttpError(409, "thread_completed", "This support conversation is completed");
  }

  const normalized = normalizeMessageBody(body);
  const senderRole = provider ? "provider" : "client";
  const replyToMessageId = String(body.replyToMessageId ?? body.reply_to_message_id ?? "").trim() || null;

  // Validate reply_to_message_id if provided
  if (replyToMessageId) {
    const [replyToMessage] = await db`
      SELECT id FROM support_messages
      WHERE id = ${replyToMessageId}::uuid AND thread_id = ${threadId}::uuid
      LIMIT 1
    `;
    if (!replyToMessage) {
      throw new HttpError(404, "reply_message_not_found", "Message to reply to not found");
    }
  }

  const [message] = await db`
    INSERT INTO support_messages (
      thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by,
      mentions, file_references, ai_reasoning, prompt_hash, structured_output, reply_to_message_id
    )
    VALUES (
      ${threadId}::uuid, ${auth.userId}, ${auth.email}, ${senderRole},
      ${normalized.content}, ${db.json(normalized.attachments as any)}, ARRAY[${auth.userId}]::TEXT[],
      ${db.json(normalized.mentions as any)}, ${db.json(normalized.fileReferences as any)},
      ${body.aiReasoning ?? body.ai_reasoning ?? null}, ${body.promptHash ?? body.prompt_hash ?? null},
      ${db.json((body.structuredOutput ?? body.structured_output ?? {}) as any)},
      ${replyToMessageId}::uuid
    )
    RETURNING *
  `;
  await db`
    UPDATE support_message_threads
    SET last_message_at = ${message.created_at}, updated_at = NOW()
    WHERE id = ${threadId}::uuid
  `;
  if (thread.request_id) {
    await addSupportEvent(
      String(thread.request_id),
      auth,
      provider ? "support.message.admin_reply" : "support.message.client_reply",
      provider ? "Admin replied to support thread" : "Client replied to support thread",
      { threadId, messageId: message.id },
    );
  }
  if (provider && thread.request_id) {
    // Send email asynchronously (don't wait)
    void (async () => {
      try {
        const [supportRequest] = await db`
          SELECT r.id, r.title, r.task_id, r.user_key_id, c.email, c.full_name
          FROM support_requests r
          LEFT JOIN support_clients c ON c.id = r.client_id
          WHERE r.id = ${thread.request_id}
          LIMIT 1
        `;
        if (supportRequest?.email) {
          await sendSupportEmail(
            String(supportRequest.email),
            String(supportRequest.user_key_id),
            "support.message.admin_reply",
            "New message on your CognizApp request",
            normalized.content || "The CognizApp team sent you a new file update.",
            {
              requestId: supportRequest.id,
              taskId: supportRequest.task_id,
              threadId,
              messageId: message.id,
              actionUrl: `/support/messages?request=${supportRequest.id}`,
            },
          );
        }
      } catch (error) {
        console.warn("[support:email] provider notification failed", error);
      }
    })();
  }
  if (!provider && thread.request_id) {
    // Send email asynchronously (don't wait)
    void (async () => {
      try {
        const [supportRequest] = await db`
          SELECT r.id, r.title, r.task_id, c.full_name
          FROM support_requests r
          LEFT JOIN support_clients c ON c.id = r.client_id
          WHERE r.id = ${thread.request_id}
          LIMIT 1
        `;
        const messageText = normalized.content || "A client sent a new support file update.";
        await Promise.allSettled(
          supportAdminEmailRecipients.map((recipient) =>
            sendSupportEmail(
              recipient,
              String(thread.user_key_id ?? auth.userId),
              "support.message.client_reply",
              `New client message: ${String(supportRequest?.title ?? "Support request")}`,
              `${auth.email} sent a message on ${String(supportRequest?.task_id ?? "a support request")}.\n\n${messageText}`,
              {
                requestId: supportRequest?.id ?? thread.request_id,
                taskId: supportRequest?.task_id,
                threadId,
                messageId: message.id,
                clientName: supportRequest?.full_name,
                clientEmail: auth.email,
                actionUrl: `/support/messages?request=${supportRequest?.id ?? thread.request_id}`,
              },
            ),
          ),
        );
      } catch (error) {
        console.warn("[support:email] admin message notification failed", error);
      }
    })();
  }
  // Invalidate cache (await to ensure stale data doesn't persist)
  await invalidateSupportCache(String(thread.user_key_id ?? auth.userId));
  await invalidateProviderSupportCache();
  return {
    message: (await getSupportMessageWithReply(String(message.id), auth.userId)) ?? {
      ...toCamel(message),
      canEdit: true,
      canDelete: true,
    },
    thread: toCamel(thread),
    provider,
  };
}

function sse(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function resolveRealtimeAuth(
  headers: Headers | Record<string, string | undefined>,
  token?: string,
) {
  if (token?.trim()) {
    return resolveAuth({ authorization: `Bearer ${token.trim()}` });
  }
  return resolveAuth(headers);
}

export const supportMessagesRoutes = new Elysia({ prefix: "/api/support", tags: ["support-messages"] })
  .onError(({ code, error, set, request }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION") {
      console.error("[Support Messages] Validation error:", {
        url: request.url,
        method: request.method,
        error: error.message || error,
      });
      set.status = 400;
      return fail("Invalid request body", "invalid_request", { validationError: error.message || String(error) });
    }
  })
  .get("/messages/threads", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const provider = canSeeProvider(auth);
    const requestId = String(query.request_id ?? query.requestId ?? "").trim();
    const cacheKey = `support:${auth.userId}:message-threads:${provider ? "provider" : "client"}:${requestId || "all"}`;
    const payload = await cache.rememberJson(cacheKey, 30, async () => {
      const rows = provider
        ? await db`
          SELECT t.*, r.title AS request_title, r.task_id, r.status AS request_status,
            c.full_name AS client_name, c.email AS client_email,
            lm.id AS last_message_id, lm.sender_key_id AS last_message_sender_key_id,
            lm.sender_name AS last_message_sender_name, lm.sender_role AS last_message_sender_role,
            lm.content AS last_message_content, lm.created_at AS last_message_created_at,
            COALESCE(unread.unread_count, 0)::int AS unread_count
          FROM support_message_threads t
          LEFT JOIN support_requests r ON r.id = t.request_id
          LEFT JOIN support_clients c ON c.user_key_id = t.user_key_id
          LEFT JOIN LATERAL (
            SELECT id, sender_key_id, sender_name, sender_role, content, created_at
            FROM support_messages
            WHERE thread_id = t.id
            ORDER BY created_at DESC
            LIMIT 1
          ) lm ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS unread_count
            FROM support_messages
            WHERE thread_id = t.id
              AND sender_key_id != ${auth.userId}
              AND NOT (${auth.userId} = ANY(read_by))
          ) unread ON TRUE
          WHERE t.request_id IS NOT NULL
            AND (${requestId || null}::uuid IS NULL OR t.request_id = ${requestId || null}::uuid)
          ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
          LIMIT 100
        `
        : await db`
          SELECT t.*, r.title AS request_title, r.task_id, r.status AS request_status,
            c.full_name AS client_name, c.email AS client_email,
            lm.id AS last_message_id, lm.sender_key_id AS last_message_sender_key_id,
            lm.sender_name AS last_message_sender_name, lm.sender_role AS last_message_sender_role,
            lm.content AS last_message_content, lm.created_at AS last_message_created_at,
            COALESCE(unread.unread_count, 0)::int AS unread_count
          FROM support_message_threads t
          LEFT JOIN support_requests r ON r.id = t.request_id
          LEFT JOIN support_clients c ON c.user_key_id = t.user_key_id
          LEFT JOIN LATERAL (
            SELECT id, sender_key_id, sender_name, sender_role, content, created_at
            FROM support_messages
            WHERE thread_id = t.id
            ORDER BY created_at DESC
            LIMIT 1
          ) lm ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS unread_count
            FROM support_messages
            WHERE thread_id = t.id
              AND sender_key_id != ${auth.userId}
              AND NOT (${auth.userId} = ANY(read_by))
          ) unread ON TRUE
          WHERE t.user_key_id = ${auth.userId}
            AND t.request_id IS NOT NULL
            AND (${requestId || null}::uuid IS NULL OR t.request_id = ${requestId || null}::uuid)
          ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
          LIMIT 100
        `;
      return { data: rows.map(mapSupportThread) };
    });
    return ok(payload);
  })
  .get("/messages/threads/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const provider = canSeeProvider(auth);
    const [thread] = provider
      ? await db`
        SELECT t.*, r.title AS request_title, r.task_id, r.status AS request_status,
          c.full_name AS client_name, c.email AS client_email,
          lm.id AS last_message_id, lm.sender_key_id AS last_message_sender_key_id,
          lm.sender_name AS last_message_sender_name, lm.sender_role AS last_message_sender_role,
          lm.content AS last_message_content, lm.created_at AS last_message_created_at,
          COALESCE(unread.unread_count, 0)::int AS unread_count
        FROM support_message_threads t
        LEFT JOIN support_requests r ON r.id = t.request_id
        LEFT JOIN support_clients c ON c.user_key_id = t.user_key_id
        LEFT JOIN LATERAL (
          SELECT id, sender_key_id, sender_name, sender_role, content, created_at
          FROM support_messages
          WHERE thread_id = t.id
          ORDER BY created_at DESC
          LIMIT 1
        ) lm ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS unread_count
          FROM support_messages
          WHERE thread_id = t.id
            AND sender_key_id != ${auth.userId}
            AND NOT (${auth.userId} = ANY(read_by))
        ) unread ON TRUE
        WHERE t.request_id IS NOT NULL
          AND (t.id = ${params.id}::uuid OR t.request_id = ${params.id}::uuid)
        LIMIT 1
      `
      : await db`
        SELECT t.*, r.title AS request_title, r.task_id, r.status AS request_status,
          c.full_name AS client_name, c.email AS client_email,
          lm.id AS last_message_id, lm.sender_key_id AS last_message_sender_key_id,
          lm.sender_name AS last_message_sender_name, lm.sender_role AS last_message_sender_role,
          lm.content AS last_message_content, lm.created_at AS last_message_created_at,
          COALESCE(unread.unread_count, 0)::int AS unread_count
        FROM support_message_threads t
        LEFT JOIN support_requests r ON r.id = t.request_id
        LEFT JOIN support_clients c ON c.user_key_id = t.user_key_id
        LEFT JOIN LATERAL (
          SELECT id, sender_key_id, sender_name, sender_role, content, created_at
          FROM support_messages
          WHERE thread_id = t.id
          ORDER BY created_at DESC
          LIMIT 1
        ) lm ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS unread_count
          FROM support_messages
          WHERE thread_id = t.id
            AND sender_key_id != ${auth.userId}
            AND NOT (${auth.userId} = ANY(read_by))
        ) unread ON TRUE
        WHERE t.request_id IS NOT NULL
          AND t.user_key_id = ${auth.userId}
          AND (t.id = ${params.id}::uuid OR t.request_id = ${params.id}::uuid)
        LIMIT 1
      `;
    if (!thread) throw new HttpError(404, "thread_not_found", "Message thread not found");
    return ok({ data: mapSupportThread(thread) });
  })
  .post("/messages/threads", async ({ headers, body }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const provider = canSeeProvider(auth);
    if (!body.requestId) {
      throw new HttpError(400, "request_required", "Support message threads must be attached to a request");
    }
    const [request] = body.requestId
      ? await db`
        SELECT id, user_key_id FROM support_requests
        WHERE id = ${body.requestId}::uuid
          AND (${provider} OR user_key_id = ${auth.userId})
        LIMIT 1
      `
      : [];
    if (body.requestId) {
      if (!request) throw new HttpError(404, "request_not_found", "Support request not found");
    }
    const threadUserId = String(request?.user_key_id ?? auth.userId);
    const [existingThread] = body.requestId
      ? await db`
        SELECT *
        FROM support_message_threads
        WHERE request_id = ${body.requestId}::uuid
          AND user_key_id = ${threadUserId}
        ORDER BY created_at ASC
        LIMIT 1
      `
      : [];
    const [thread] = existingThread
      ? [existingThread]
      : await db`
        INSERT INTO support_message_threads (request_id, order_id, user_key_id, type)
        VALUES (
          ${body.requestId}, ${body.orderId ?? null}, ${threadUserId}, 'request'
        )
        RETURNING *
      `;
    await invalidateSupportCache(threadUserId);
    return ok({
      data: toCamel(thread),
      message: existingThread ? "Conversation ready" : "Conversation started",
    });
  }, {
    body: t.Object({
      requestId: t.Optional(t.String()),
      orderId: t.Optional(t.String()),
      type: t.Optional(t.String()),
    }),
  })
  .get("/messages/stream", async ({ headers, query }) => {
    const threadId = String(query.threadId ?? query.thread_id ?? "").trim();
    const token = String(query.token ?? "").trim();
    const afterRaw = String(query.after ?? "").trim();
    const after = afterRaw ? new Date(afterRaw) : null;
    const afterDate = after && Number.isFinite(after.getTime()) ? after : null;
    if (!threadId) throw new HttpError(400, "thread_required", "Message thread is required");

    const auth = await resolveRealtimeAuth(headers, token);
    await getAuthorizedSupportMessageThread(auth, threadId);
    const db = getDb();
    const encoder = new TextEncoder();
    const seen = new Map<string, string>();

    let interval: ReturnType<typeof setInterval> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller: ReadableStreamDefaultController<Uint8Array>) {
        closeTimer = setTimeout(() => {
          closed = true;
          controller.enqueue(encoder.encode(sse({
            type: "reconnect",
            threadId,
            sentAt: new Date().toISOString(),
          })));
          controller.close();
        }, supportRealtimeStreamMs);

        controller.enqueue(encoder.encode(sse({
          type: "ready",
          threadId,
          userId: auth.userId,
          transport: "sse",
          connectedAt: new Date().toISOString(),
        })));

        const poll = async () => {
          if (closed) return;
          try {
            const rows = await db`
              SELECT m.*,
                reply_msg.content AS reply_to_content,
                reply_msg.sender_name AS reply_to_sender_name,
                reply_msg.sender_role AS reply_to_sender_role,
                reply_msg.created_at AS reply_to_created_at
              FROM support_messages m
              LEFT JOIN support_messages reply_msg ON reply_msg.id = m.reply_to_message_id
              WHERE m.thread_id = ${threadId}::uuid
                AND (
                  ${afterDate}::timestamptz IS NULL
                  OR m.created_at > ${afterDate}
                  OR m.edited_at IS NOT NULL
                  OR m.deleted_at IS NOT NULL
                )
              ORDER BY m.created_at DESC
              LIMIT 100
            `;
            for (const row of rows.reverse()) {
              const id = String(row.id);
              const signature = JSON.stringify([
                row.content,
                row.edited_at,
                row.deleted_at,
                row.reply_to_message_id,
                row.attachments,
              ]);
              const previousSignature = seen.get(id);
              if (previousSignature === signature) continue;
              seen.set(id, signature);
              controller.enqueue(encoder.encode(sse({
                type: previousSignature ? "message.updated" : "message.created",
                threadId,
                message: mapSupportMessage(row, auth.userId),
                sentAt: new Date().toISOString(),
              })));
            }
          } catch (error) {
            controller.enqueue(encoder.encode(sse({
              type: "error",
              threadId,
              message: "Realtime stream polling failed",
            })));
            console.warn("[support:messages:stream] poll failed", error);
          }
        };

        await poll();
        interval = setInterval(poll, 1000);
      },
      cancel() {
        closed = true;
        if (interval) clearInterval(interval);
        if (closeTimer) clearTimeout(closeTimer);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  })
  .get("/messages/references", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const payload = await cache.rememberJson(`support:${auth.userId}:message-references`, 90, async () => {
      const requests = await db`
      SELECT id, task_id, title, status, payment_status, updated_at
      FROM support_requests
      WHERE user_key_id = ${auth.userId}
      ORDER BY updated_at DESC
      LIMIT 25
    `;
      const files = await db`
      SELECT f.id, f.request_id, f.file_name, f.file_url, f.file_type, f.file_size, f.purpose, f.created_at
      FROM support_files f
      LEFT JOIN support_requests r ON r.id = f.request_id
      WHERE f.user_key_id = ${auth.userId}
        AND (f.request_id IS NULL OR r.user_key_id = ${auth.userId})
      ORDER BY f.created_at DESC
      LIMIT 50
    `;
      return { data: { requests: requests.map(toCamel), files: files.map(toCamel) } };
    });
    return ok(payload);
  })
  .get("/messages/threads/:id/messages", async ({ headers, params, set }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const { thread } = await getAuthorizedSupportMessageThread(auth, params.id);
    const messages = await db`
      SELECT m.*,
        reply_msg.content AS reply_to_content,
        reply_msg.sender_name AS reply_to_sender_name,
        reply_msg.sender_role AS reply_to_sender_role,
        reply_msg.created_at AS reply_to_created_at
      FROM support_messages m
      LEFT JOIN support_messages reply_msg ON reply_msg.id = m.reply_to_message_id
      WHERE m.thread_id = ${params.id}::uuid
      ORDER BY m.created_at ASC
      LIMIT 500
    `;
    await db`
      UPDATE support_messages
      SET read_by = CASE
        WHEN ${auth.userId} = ANY(read_by) THEN read_by
        ELSE array_append(read_by, ${auth.userId})
      END
      WHERE thread_id = ${params.id}::uuid
        AND sender_key_id != ${auth.userId}
    `;
    await invalidateSupportCache(String(thread.user_key_id ?? auth.userId));
    set.headers["Cache-Control"] = "private, max-age=5, stale-while-revalidate=30";

    // Map messages with reply_to information
    const mappedMessages = messages.map((message) =>
      mapSupportMessage(message, auth.userId),
    );

    return ok({ data: mappedMessages });
  })
  .post("/messages/threads/:id/messages", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    const result = await createSupportMessage(auth, params.id, body);
    const { broadcastSupportMessage } = await import("./realtime");
    broadcastSupportMessage(params.id, result.message);
    return ok({ data: result.message, message: "Message sent" });
  }, {
    body: t.Object({
      content: t.Optional(t.String()),
      body: t.Optional(t.String()),
      attachments: t.Optional(t.Array(t.Any())),
      mentions: t.Optional(t.Array(t.Any())),
      fileReferences: t.Optional(t.Array(t.Any())),
      file_references: t.Optional(t.Array(t.Any())),
      aiReasoning: t.Optional(t.String()),
      ai_reasoning: t.Optional(t.String()),
      promptHash: t.Optional(t.String()),
      prompt_hash: t.Optional(t.String()),
      structuredOutput: t.Optional(t.Any()),
      structured_output: t.Optional(t.Any()),
      replyToMessageId: t.Optional(t.Union([t.String(), t.Null()])),
      reply_to_message_id: t.Optional(t.Union([t.String(), t.Null()])),
    }, { additionalProperties: true }),
  })
  .patch("/messages/threads/:threadId/messages/:messageId", async ({ headers, params, body }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    await getAuthorizedSupportMessageThread(auth, params.threadId);

    const newContent = String(body.content ?? body.body ?? "").trim();
    if (!newContent) {
      throw new HttpError(400, "content_required", "Message content is required");
    }
    if (newContent.length > maxSupportMessageLength) {
      throw new HttpError(413, "message_too_large", "Message is too large");
    }

    // Get the existing message
    const [existingMessage] = await db`
      SELECT * FROM support_messages
      WHERE id = ${params.messageId}::uuid
        AND thread_id = ${params.threadId}::uuid
        AND sender_key_id = ${auth.userId}
        AND deleted_at IS NULL
      LIMIT 1
    `;

    if (!existingMessage) {
      throw new HttpError(404, "message_not_found", "Message not found or you don't have permission to edit it");
    }

    // Store old content in edit history
    const oldEditHistory = Array.isArray(existingMessage.edit_history)
      ? existingMessage.edit_history
      : [];
    const newEditHistory = [
      ...oldEditHistory,
      {
        content: existingMessage.content,
        editedAt: new Date().toISOString(),
        editedBy: auth.userId,
      },
    ];

    // Update the message
    const [updatedMessage] = await db`
      UPDATE support_messages
      SET
        content = ${newContent},
        edited_at = NOW(),
        edit_history = ${db.json(newEditHistory as any)}
      WHERE id = ${params.messageId}::uuid
      RETURNING *
    `;

    const hydratedMessage =
      (await getSupportMessageWithReply(String(updatedMessage.id), auth.userId)) ?? {
        ...toCamel(updatedMessage),
        canEdit: true,
        canDelete: true,
      };
    const { broadcastSupportMessageUpdate } = await import("./realtime");
    broadcastSupportMessageUpdate(params.threadId, hydratedMessage);

    return ok({ data: hydratedMessage, message: "Message updated" });
  }, {
    body: t.Object({
      content: t.Optional(t.String()),
      body: t.Optional(t.String()),
    }),
  })
  .delete("/messages/threads/:threadId/messages/:messageId", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    await getAuthorizedSupportMessageThread(auth, params.threadId);

    // Get the existing message
    const [existingMessage] = await db`
      SELECT * FROM support_messages
      WHERE id = ${params.messageId}::uuid
        AND thread_id = ${params.threadId}::uuid
        AND sender_key_id = ${auth.userId}
        AND deleted_at IS NULL
      LIMIT 1
    `;

    if (!existingMessage) {
      throw new HttpError(404, "message_not_found", "Message not found or you don't have permission to delete it");
    }

    // Soft delete the message
    const [deletedMessage] = await db`
      UPDATE support_messages
      SET
        deleted_at = NOW(),
        deleted_by = ${auth.userId}
      WHERE id = ${params.messageId}::uuid
      RETURNING *
    `;

    const { broadcastSupportMessageUpdate } = await import("./realtime");
    broadcastSupportMessageUpdate(params.threadId, {
      ...toCamel(deletedMessage),
      canEdit: false,
      canDelete: false,
    });

    return ok({ data: toCamel(deletedMessage), message: "Message deleted" });
  })
  .post("/ai/chat", async ({ headers, body }) => {
    const auth = await resolveAuth(headers);
    const db = getDb();
    const prompt = String(body.prompt ?? body.body ?? "").trim();
    if (!prompt) {
      throw new HttpError(400, "prompt_required", "Message text is required");
    }

    const threadId = String(body.threadId ?? body.thread_id ?? "").trim();
    const mentions = Array.isArray(body.mentions) ? body.mentions : [];
    const fileReferences = Array.isArray(body.fileReferences)
      ? body.fileReferences
      : Array.isArray(body.file_references)
        ? body.file_references
        : [];
    const promptHash = hashSupportPrompt({
      prompt,
      mentions,
      fileReferences,
      userId: auth.userId,
      model: getSupportAiModel(),
    });

    const [thread] = threadId
      ? await db`
          SELECT * FROM support_message_threads
          WHERE id = ${threadId}::uuid AND user_key_id = ${auth.userId}
          LIMIT 1
        `
      : await db`
          INSERT INTO support_message_threads (request_id, order_id, user_key_id, type, last_message_at)
          VALUES (NULL, NULL, ${auth.userId}, 'ai', NOW())
          RETURNING *
        `;
    if (!thread) throw new HttpError(404, "thread_not_found", "AI conversation not found");

    const [userMessage] = await db`
      INSERT INTO support_messages (
        thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by,
        mentions, file_references, prompt_hash
      )
      VALUES (
        ${thread.id}, ${auth.userId}, ${auth.email}, 'client', ${prompt}, '[]'::jsonb, ARRAY[${auth.userId}]::TEXT[],
        ${db.json(mentions as any)}, ${db.json(fileReferences as any)}, ${promptHash}
      )
      RETURNING *
    `;

    const [cached] = await db`
      SELECT * FROM support_ai_response_cache
      WHERE user_key_id = ${auth.userId} AND prompt_hash = ${promptHash}
      LIMIT 1
    `;

    const aiResult = cached
      ? {
        model: cached.model,
        reasoning: cached.reasoning,
        response: cached.response,
        complexity: cached.complexity === "complex" ? "complex" : "simple",
        actionItems: cached.action_items ?? [],
        provider: "cache" as const,
      }
      : await generateSupportAiResponse({
        prompt,
        requestReferences: mentions,
        fileReferences,
      });
    const publicAiResult = {
      reasoning: aiResult.reasoning,
      response: aiResult.response,
      complexity: aiResult.complexity,
      actionItems: aiResult.actionItems,
      model: getPublicSupportAiModelName(aiResult.model),
        provider: "cognizapp" as const,
    };

    if (!cached) {
      await db`
        INSERT INTO support_ai_response_cache (
          user_key_id, prompt_hash, prompt, model, reasoning, response, complexity, action_items, structured_output
        )
        VALUES (
          ${auth.userId}, ${promptHash}, ${prompt}, ${aiResult.model}, ${aiResult.reasoning},
          ${aiResult.response}, ${aiResult.complexity}, ${db.json(aiResult.actionItems as any)},
          ${db.json(aiResult as any)}
        )
        ON CONFLICT (user_key_id, prompt_hash) DO UPDATE
        SET updated_at = NOW()
      `;
    }

    const [assistantMessage] = await db`
      INSERT INTO support_messages (
        thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by,
        mentions, file_references, ai_reasoning, prompt_hash, structured_output
      )
      VALUES (
        ${thread.id}, 'support-ai', 'CognizApp AI', 'ai', ${aiResult.response}, '[]'::jsonb, ARRAY[]::TEXT[],
        ${db.json(mentions as any)}, ${db.json(fileReferences as any)}, ${aiResult.reasoning}, ${promptHash},
        ${db.json(publicAiResult as any)}
      )
      RETURNING *
    `;
    await db`
      UPDATE support_message_threads
      SET type = 'ai', last_message_at = ${assistantMessage.created_at}, updated_at = NOW()
      WHERE id = ${thread.id}
    `;

    return ok({
      data: {
        thread: toCamel(thread),
        userMessage: toCamel(userMessage),
        assistantMessage: toCamel(assistantMessage),
        ai: publicAiResult,
        cached: Boolean(cached),
      },
      message: cached ? "AI response loaded from cache" : "AI response generated",
    });
  }, {
    body: t.Object({
      threadId: t.Optional(t.String()),
      thread_id: t.Optional(t.String()),
      prompt: t.Optional(t.String()),
      body: t.Optional(t.String()),
      mentions: t.Optional(t.Array(t.Any())),
      fileReferences: t.Optional(t.Array(t.Any())),
      file_references: t.Optional(t.Array(t.Any())),
    }),
  });
